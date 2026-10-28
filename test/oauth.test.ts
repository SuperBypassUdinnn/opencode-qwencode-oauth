import { afterEach, describe, expect, it } from "bun:test";
import { pollQwenDeviceToken } from "../src/qwen/oauth";

const originalFetch = globalThis.fetch;
const options = { clientId: "client", oauthBaseUrl: "https://chat.qwen.ai" };

function stubFetch(handler: (call: number) => Response): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    expect(new Headers(init?.headers).get("accept")).toBe("application/json");
    return handler(calls.length);
  }) as typeof fetch;
  return calls;
}

function poll(intervalSeconds = 5) {
  return pollQwenDeviceToken(
    options,
    "device",
    intervalSeconds,
    Date.now() + 5000,
    "verifier",
  );
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("pollQwenDeviceToken", () => {
  it("reports an edge block page instead of a bare polling failure", async () => {
    stubFetch(
      () =>
        new Response(
          "<!doctype html><html><head><title>405</title></head></html>",
          { status: 405, headers: { "content-type": "text/html" } },
        ),
    );

    const result = await poll();

    expect(result.type).toBe("failed");
    if (result.type !== "failed") return;
    expect(result.status).toBe(405);
    expect(result.error).toContain("HTTP 405");
    expect(result.error).toContain("HTML block page");
  });

  it("includes the HTTP status with an OAuth error code", async () => {
    stubFetch(() => jsonResponse({ error: "invalid_request" }, 400));

    const result = await poll();

    expect(result.type).toBe("failed");
    if (result.type !== "failed") return;
    expect(result.code).toBe("invalid_request");
    expect(result.error).toBe("invalid_request (HTTP 400)");
  });

  it("keeps the status on a described OAuth error", async () => {
    stubFetch(() =>
      jsonResponse(
        {
          error: "invalid_grant",
          error_description: "The device code has been revoked",
        },
        400,
      ),
    );

    const result = await poll();

    expect(result.type).toBe("failed");
    if (result.type !== "failed") return;
    expect(result.error).toBe("The device code has been revoked (HTTP 400)");
  });

  it("keeps polling while the grant is pending", async () => {
    const calls = stubFetch((call) =>
      call === 1
        ? jsonResponse({ error: "authorization_pending" }, 400)
        : jsonResponse(
            {
              access_token: "access",
              refresh_token: "refresh",
              expires_in: 3600,
            },
            200,
          ),
    );

    const result = await poll(0);

    expect(calls).toHaveLength(2);
    expect(result.type).toBe("success");
    if (result.type !== "success") return;
    expect(result.refresh).toBe("refresh");
  });
});
