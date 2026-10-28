import { type Credential, Plugin } from "@opencode/plugin";
import { QWEN_DEFAULT_SCOPES, QWEN_OAUTH_BASE_URL } from "./constants";
import {
  getMinRateLimitWait,
  loadAccounts,
  loadTrackerState,
  markRateLimited,
  recordFailure,
  recordSuccess,
  saveAccounts,
  saveTrackerState,
  selectAccount,
  updateAccount,
} from "./plugin/account";
import { accessTokenExpired } from "./plugin/auth";
import { type LoadedConfig, loadConfig } from "./plugin/config";
import { sleep } from "./plugin/fetch/rate-limit";
import {
  RATE_LIMIT_BACKOFF_MS,
  retryDecision,
  SERVER_ERROR_BACKOFF_MS,
} from "./plugin/fetch/retry";
import { transformRequestAsync } from "./plugin/fetch/transform";
import {
  createLogger,
  initDebugFromEnv,
  setLoggerQuietMode,
} from "./plugin/logger";
import {
  getAdaptiveTracker,
  getHealthTracker,
  getTokenTracker,
  initAdaptiveTracker,
  initHealthTracker,
  initTokenTracker,
} from "./plugin/rotation";
import { refreshAccessToken } from "./plugin/token";
import type { OAuthAuthDetails } from "./plugin/types";
import { authorizeQwenDevice, pollQwenDeviceToken } from "./qwen/oauth";
import { transformHeader } from "./transform/header";
import {
  createTransformContext,
  transformChatCompletionsToResponses,
} from "./transform/response";
import {
  createSSETransformContext,
  createSSETransformStream,
} from "./transform/sse";

const logger = createLogger("plugin");

const PROVIDER_ID = "qwen";
const INTEGRATION_ID = PROVIDER_ID;
const OAUTH_METHOD_ID = "device";

type PendingRequest = {
  needsResponsesTransform: boolean;
  accountIndex: number;
  at: number;
};

/**
 * Request-side state consumed by the matching response hook. Entries are keyed
 * both by the outbound URL (exact) and by session + kind (fallback), because
 * the response event reports its own view of the request. The URL key keeps
 * concurrent calls of the same kind apart; the fallback keeps attribution
 * working if the reported URL differs.
 */
const pending = new Map<string, PendingRequest>();

function requestKey(sessionID: string, kind: string, url?: string): string {
  return url ? `${sessionID}:${kind}:${url}` : `${sessionID}:${kind}`;
}

function rememberPending(
  sessionID: string,
  kind: string,
  url: string,
  meta: PendingRequest,
): void {
  pending.set(requestKey(sessionID, kind, url), meta);
  pending.set(requestKey(sessionID, kind), meta);
}

function takePending(
  sessionID: string,
  kind: string,
  url: string,
): PendingRequest | undefined {
  const exact = requestKey(sessionID, kind, url);
  const meta = pending.get(exact) ?? pending.get(requestKey(sessionID, kind));
  pending.delete(exact);
  pending.delete(requestKey(sessionID, kind));
  return meta;
}

function pruneStale(): void {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [key, value] of pending) {
    if (value.at < cutoff) pending.delete(key);
  }
}

function buildOAuthOptions(config: LoadedConfig): {
  clientId: string;
  oauthBaseUrl: string;
  scopes: string[];
} {
  const base = (config.oauth_base_url ?? "").trim();
  const oauthBaseUrl =
    base.startsWith("http://") || base.startsWith("https://")
      ? base
      : QWEN_OAUTH_BASE_URL;
  return {
    clientId: config.client_id,
    oauthBaseUrl,
    scopes: QWEN_DEFAULT_SCOPES,
  };
}

function getPidOffset(config: LoadedConfig): number {
  return config.pid_offset_enabled ? process.pid : 0;
}

function initializeTrackers(config: LoadedConfig): void {
  initHealthTracker(
    config.health_score
      ? {
          initial: config.health_score.initial,
          successReward: config.health_score.success_reward,
          rateLimitPenalty: config.health_score.rate_limit_penalty,
          failurePenalty: config.health_score.failure_penalty,
          recoveryRatePerHour: config.health_score.recovery_rate_per_hour,
          minUsable: config.health_score.min_usable,
        }
      : undefined,
  );
  initTokenTracker(
    config.token_bucket
      ? {
          maxTokens: config.token_bucket.max_tokens,
          regenerationRatePerMinute:
            config.token_bucket.regeneration_rate_per_minute,
        }
      : undefined,
  );
  if (config.rotation_strategy === "adaptive" && config.adaptive) {
    initAdaptiveTracker({
      learningRate: config.adaptive.learning_rate,
      historyWindow: config.adaptive.history_window,
      minWeight: config.adaptive.min_weight,
      maxWeight: config.adaptive.max_weight,
      cooldownPeriodMs: config.adaptive.cooldown_period_seconds * 1000,
    });
  }
}

// Credential.OAuth has no first-class resourceUrl, so it travels in metadata.
function extractResourceUrl(credential: Credential.OAuth): string | undefined {
  const meta = credential.metadata as Record<string, unknown> | undefined;
  const value = meta?.resourceUrl;
  return typeof value === "string" ? value : undefined;
}

function toCredentialOAuth(
  auth: OAuthAuthDetails,
  methodID: Credential.OAuth["methodID"],
): Credential.OAuth {
  return {
    type: "oauth",
    methodID,
    refresh: auth.refresh,
    access: auth.access ?? "",
    expires: auth.expires ?? 0,
    ...(auth.resourceUrl
      ? { metadata: { resourceUrl: auth.resourceUrl } }
      : {}),
  };
}

export const QwenOAuthPlugin = Plugin.define({
  id: INTEGRATION_ID,

  async setup(ctx) {
    const config = loadConfig(ctx.location.directory);
    setLoggerQuietMode(config.quiet_mode);
    initDebugFromEnv();
    initializeTrackers(config);

    const existingStorage = await loadAccounts();
    await loadTrackerState(
      getHealthTracker(),
      getTokenTracker(),
      existingStorage?.accounts,
    );

    const pidOffset = getPidOffset(config);
    const oauthOptions = buildOAuthOptions(config);
    const refreshBuffer = config.proactive_refresh
      ? config.refresh_window_seconds
      : 0;
    const maxRateLimitWaitMs = config.max_rate_limit_wait_seconds * 1000;

    logger.debug("Plugin initialized", {
      providerId: PROVIDER_ID,
      strategy: config.rotation_strategy,
      pidOffset: config.pid_offset_enabled ? pidOffset : "disabled",
    });

    await ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          id: OAUTH_METHOD_ID,
          type: "oauth",
          label: "Qwen OAuth",
        },
        authorize: async () => {
          const device = await authorizeQwenDevice(oauthOptions);
          const url = device.verificationUriComplete ?? device.verificationUri;

          return {
            url,
            instructions: `Open ${device.verificationUri} and enter code ${device.userCode}`,
            mode: "auto" as const,
            callback: (async (): Promise<Credential.OAuth> => {
              const result = await pollQwenDeviceToken(
                oauthOptions,
                device.deviceCode,
                device.intervalSeconds,
                device.expiresAt,
                device.codeVerifier,
              );
              if (result.type === "failed") throw new Error(result.error);
              return toCredentialOAuth(
                {
                  type: "oauth",
                  refresh: result.refresh,
                  access: result.access,
                  expires: result.expires,
                  resourceUrl: result.resourceUrl,
                },
                OAUTH_METHOD_ID as Credential.OAuth["methodID"],
              );
            })(),
          };
        },
        refresh: async (
          credential: Credential.OAuth,
        ): Promise<Credential.OAuth> => {
          const refreshed = await refreshAccessToken(
            {
              type: "oauth",
              refresh: credential.refresh,
              access: credential.access,
              expires: credential.expires,
              resourceUrl: extractResourceUrl(credential),
            },
            oauthOptions,
          );
          if (!refreshed) throw new Error("Token refresh returned null");
          return toCredentialOAuth(refreshed, credential.methodID);
        },
        label: (credential: Credential.OAuth) => {
          const resourceUrl = extractResourceUrl(credential);
          if (!resourceUrl) return undefined;
          try {
            return new URL(resourceUrl).hostname;
          } catch {
            return undefined;
          }
        },
      });
    });

    // Request side: pick an account, refresh its token when due, rewrite the
    // Responses call into a Chat Completions call, and attach the bearer token.
    const requestHook = await ctx.session.hook(
      "http.request",
      async (event) => {
        if (event.model.providerID !== PROVIDER_ID) return;

        pruneStale();

        const storage = await loadAccounts();
        if (!storage || storage.accounts.length === 0) {
          logger.debug("No Qwen accounts stored; leaving request untouched");
          return;
        }

        let accountStorage = storage;
        const startedAt = Date.now();
        let attempts = 0;

        // Select an account, refresh its token, and hand the request to it. A
        // revoked refresh token disqualifies only that account, so the loop
        // moves on instead of failing the whole request.
        while (true) {
          const now = Date.now();
          const selection = selectAccount(
            accountStorage,
            config.rotation_strategy,
            now,
            {
              healthTracker: getHealthTracker(),
              tokenTracker: getTokenTracker(),
              adaptiveTracker: getAdaptiveTracker(),
              pidOffset,
            },
          );

          if (!selection) {
            const waitMs = getMinRateLimitWait(accountStorage, now);
            if (!waitMs) {
              throw new Error(
                "Qwen OAuth: no usable account (all require re-authentication).",
              );
            }
            if (
              maxRateLimitWaitMs > 0 &&
              now - startedAt + waitMs > maxRateLimitWaitMs
            ) {
              throw new Error(
                "Qwen OAuth: all accounts are rate-limited. Try again later.",
              );
            }
            logger.debug("All Qwen accounts rate-limited; waiting", { waitMs });
            await sleep(waitMs);
            continue;
          }

          accountStorage = selection.storage;
          const account = selection.account;

          let auth: OAuthAuthDetails = {
            type: "oauth",
            refresh: account.refreshToken,
            access: account.accessToken,
            expires: account.expires,
            resourceUrl: account.resourceUrl,
          };

          if (!auth.access || accessTokenExpired(auth, refreshBuffer)) {
            try {
              const refreshed = await refreshAccessToken(auth, oauthOptions);
              if (!refreshed) throw new Error("Token refresh failed");
              auth = refreshed;
              accountStorage = updateAccount(accountStorage, selection.index, {
                refreshToken: refreshed.refresh,
                accessToken: refreshed.access,
                expires: refreshed.expires,
                resourceUrl: refreshed.resourceUrl ?? account.resourceUrl,
                lastUsed: now,
              });
            } catch (error) {
              const code = (error as { code?: string }).code ?? "";
              const revoked =
                code === "invalid_grant" || code === "invalid_token";
              if (revoked) {
                accountStorage = updateAccount(
                  accountStorage,
                  selection.index,
                  {
                    requiresReauth: true,
                    accessToken: undefined,
                    expires: undefined,
                  },
                );
                await saveAccounts(accountStorage);
                attempts += 1;
                if (attempts >= accountStorage.accounts.length) throw error;
                continue;
              }
              throw error;
            }
          }

          const transformed = await transformRequestAsync(event.request);
          const headers = transformHeader(transformed.init.headers, {
            accessToken: auth.access,
            forceJsonContentType: transformed.needsResponsesTransform,
          });

          const outbound = new Request(transformed.url, {
            ...transformed.init,
            headers,
          });
          event.request = outbound;

          rememberPending(event.sessionID, event.kind, outbound.url, {
            needsResponsesTransform: transformed.needsResponsesTransform,
            accountIndex: selection.index,
            at: Date.now(),
          });

          await saveAccounts(accountStorage);
          return;
        }
      },
    );

    // Response side: translate Chat Completions back into the Responses shape
    // and record per-account health so rotation can react to rate limits.
    const responseHook = await ctx.session.hook(
      "http.response",
      async (event) => {
        if (event.model.providerID !== PROVIDER_ID) return;

        const meta = takePending(
          event.sessionID,
          event.kind,
          event.request.url,
        );
        if (!meta) return;

        const storage = await loadAccounts();
        const status = event.response.status;
        const rateLimited = status === 429;
        const serverError = status >= 500;

        if (storage) {
          let next = storage;
          if (rateLimited || serverError) {
            next = markRateLimited(
              next,
              meta.accountIndex,
              rateLimited ? RATE_LIMIT_BACKOFF_MS : SERVER_ERROR_BACKOFF_MS,
            );
            next = recordFailure(next, meta.accountIndex);
          } else if (event.response.ok) {
            next = recordSuccess(next, meta.accountIndex);
          }
          if (next !== storage) await saveAccounts(next);
        }

        if (rateLimited) getHealthTracker().recordRateLimit(meta.accountIndex);
        else if (serverError)
          getHealthTracker().recordFailure(meta.accountIndex);
        else if (event.response.ok)
          getHealthTracker().recordSuccess(meta.accountIndex);

        if (config.rotation_strategy === "adaptive") {
          const adaptive = getAdaptiveTracker();
          if (rateLimited) adaptive.recordRateLimit(meta.accountIndex);
          else if (serverError) adaptive.recordFailure(meta.accountIndex);
          else if (event.response.ok) adaptive.recordSuccess(meta.accountIndex);
        }

        if (event.response.ok) {
          await saveTrackerState(getHealthTracker(), getTokenTracker());
        }

        if (!meta.needsResponsesTransform || !event.response.ok) return;

        const contentType = event.response.headers.get("content-type") ?? "";

        if (contentType.includes("text/event-stream") && event.response.body) {
          const sseCtx = createSSETransformContext(logger);
          const stream = createSSETransformStream(sseCtx);
          event.response = new Response(
            event.response.body.pipeThrough(stream),
            {
              status: event.response.status,
              statusText: event.response.statusText,
              headers: event.response.headers,
            },
          );
          return;
        }

        try {
          const chatBody = await event.response.json();
          const responsesBody = transformChatCompletionsToResponses(
            chatBody,
            createTransformContext(),
          );
          event.response = new Response(JSON.stringify(responsesBody), {
            status: event.response.status,
            statusText: event.response.statusText,
            headers: new Headers({ "content-type": "application/json" }),
          });
        } catch (error) {
          logger.debug("Response transform skipped", {
            error: String(error),
          });
        }
      },
    );

    // Retry side: a 429 or 5xx from one account should rotate to the next
    // account instead of surfacing to the user. The response hook has already
    // marked that account rate-limited, so the retried request selects another.
    const retryHook = await ctx.session.hook(
      "retry",
      async (event) => {
        if (event.model.providerID !== PROVIDER_ID) return;

        event.decision = retryDecision({
          status: event.error.status,
          retryAfterMs: event.error.retryAfterMs,
          attempt: event.attempt,
          maxWaitMs: maxRateLimitWaitMs,
        });
      },
      { providerID: PROVIDER_ID },
    );

    logger.info("Qwen OAuth plugin ready", {
      strategy: config.rotation_strategy,
      accounts: existingStorage?.accounts.length ?? 0,
    });

    return () => {
      requestHook.dispose();
      responseHook.dispose();
      retryHook.dispose();
    };
  },
});

export const QwenCLIOAuthPlugin = QwenOAuthPlugin;
export const createQwenOAuthPlugin = (_providerId: string) => QwenOAuthPlugin;
export default QwenOAuthPlugin;
