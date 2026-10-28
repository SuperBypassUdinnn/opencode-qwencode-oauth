import { afterEach, describe, expect, it, mock } from "bun:test";
import { QwenTokenRefreshError, refreshAccessToken } from "../src/plugin/token";
import type { OAuthAuthDetails } from "../src/plugin/types";

const mockRefreshQwenToken = mock(() =>
  Promise.resolve({
    type: "success" as const,
    access: "access-new",
    refresh: "refresh-new",
    expires: 123456,
    resourceUrl: "https://resource.example",
  }),
);

mock.module("../src/qwen/oauth", () => ({
  refreshQwenToken: mockRefreshQwenToken,
}));

afterEach(() => {
  mockRefreshQwenToken.mockClear();
});

describe("refreshAccessToken", () => {
  it("returns updated auth details", async () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "refresh-old",
      access: "access-old",
      expires: 1000,
    };

    const result = await refreshAccessToken(auth, {
      clientId: "client",
      oauthBaseUrl: "https://chat.qwen.ai",
    });

    expect(result?.access).toBe("access-new");
    expect(result?.refresh).toBe("refresh-new");
    expect(result?.resourceUrl).toBe("https://resource.example");
  });

  it("does not call the token endpoint when refresh is the string undefined", async () => {
    const auth = {
      type: "oauth" as const,
      refresh: "undefined",
      access: "access-old",
    } as OAuthAuthDetails;

    await expect(
      refreshAccessToken(auth, {
        clientId: "client",
        oauthBaseUrl: "https://chat.qwen.ai",
      }),
    ).rejects.toThrow(QwenTokenRefreshError);

    expect(mockRefreshQwenToken).not.toHaveBeenCalled();
  });
});
