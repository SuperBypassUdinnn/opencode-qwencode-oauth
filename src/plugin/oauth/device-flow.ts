import {
  authorizeQwenDevice,
  pollQwenDeviceToken,
  type QwenOAuthOptions,
} from "../../qwen/oauth";

export interface OAuthFlowResult {
  refresh: string;
  access: string;
  expires: number;
  resourceUrl?: string;
}

/** Runs the full device flow headlessly, for callers that do not register a method. */
export async function executeOAuthFlow(
  options: QwenOAuthOptions,
): Promise<OAuthFlowResult> {
  const device = await authorizeQwenDevice(options);
  const result = await pollQwenDeviceToken(
    options,
    device.deviceCode,
    device.intervalSeconds,
    device.expiresAt,
    device.codeVerifier,
  );

  if (result.type === "failed") {
    throw new Error(`OAuth failed: ${result.error}`);
  }

  return {
    refresh: result.refresh,
    access: result.access,
    expires: result.expires,
    resourceUrl: result.resourceUrl,
  };
}
