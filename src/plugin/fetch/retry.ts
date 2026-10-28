/** Fallback backoff when the provider does not send a Retry-After hint. */
export const RATE_LIMIT_BACKOFF_MS = 30_000;
export const SERVER_ERROR_BACKOFF_MS = 20_000;
/** Upper bound on automatic retries so a persistently failing route cannot loop. */
export const MAX_RETRIES = 3;

export interface RetryInput {
  /** HTTP status carried by the session error, when the provider surfaced one. */
  status: number | undefined;
  /** Wait the provider asked for, in milliseconds. */
  retryAfterMs?: number;
  /** Attempt number reported by the session, counting the first call as 1. */
  attempt: number;
  /** `max_rate_limit_wait_seconds` in milliseconds; 0 disables the cap. */
  maxWaitMs: number;
}

export type RetryOutcome = { retry: true; delay: number } | { retry: false };

/**
 * Decides whether a failed request should be retried. Only rate limits and
 * server errors qualify: retrying a 4xx would just repeat a bad request.
 */
export function retryDecision(input: RetryInput): RetryOutcome {
  const rateLimited = input.status === 429;
  const serverError = typeof input.status === "number" && input.status >= 500;
  if (!rateLimited && !serverError) return { retry: false };
  if (input.attempt >= MAX_RETRIES) return { retry: false };

  const fallback = rateLimited
    ? RATE_LIMIT_BACKOFF_MS
    : SERVER_ERROR_BACKOFF_MS;
  const wanted = input.retryAfterMs ?? fallback;
  const delay =
    input.maxWaitMs > 0 ? Math.min(wanted, input.maxWaitMs) : wanted;

  return { retry: true, delay };
}
