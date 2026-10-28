import { describe, expect, it } from "bun:test";
import {
  MAX_RETRIES,
  RATE_LIMIT_BACKOFF_MS,
  retryDecision,
  SERVER_ERROR_BACKOFF_MS,
} from "../src/plugin/fetch/retry";

describe("retryDecision", () => {
  it("retries a rate limit with the provider hint", () => {
    expect(
      retryDecision({
        status: 429,
        retryAfterMs: 1_000,
        attempt: 1,
        maxWaitMs: 300_000,
      }),
    ).toEqual({ retry: true, delay: 1_000 });
  });

  it("falls back to the rate limit backoff without a hint", () => {
    expect(retryDecision({ status: 429, attempt: 1, maxWaitMs: 0 })).toEqual({
      retry: true,
      delay: RATE_LIMIT_BACKOFF_MS,
    });
  });

  it("retries server errors with the server backoff", () => {
    expect(retryDecision({ status: 503, attempt: 1, maxWaitMs: 0 })).toEqual({
      retry: true,
      delay: SERVER_ERROR_BACKOFF_MS,
    });
  });

  it("caps the delay at the configured wait", () => {
    expect(
      retryDecision({
        status: 429,
        retryAfterMs: 600_000,
        attempt: 1,
        maxWaitMs: 30_000,
      }),
    ).toEqual({ retry: true, delay: 30_000 });
  });

  it("does not retry client errors", () => {
    expect(retryDecision({ status: 400, attempt: 1, maxWaitMs: 0 })).toEqual({
      retry: false,
    });
  });

  it("does not retry when the status is missing", () => {
    expect(
      retryDecision({ status: undefined, attempt: 1, maxWaitMs: 0 }),
    ).toEqual({ retry: false });
  });

  it("stops after the retry budget", () => {
    expect(
      retryDecision({ status: 429, attempt: MAX_RETRIES, maxWaitMs: 0 }),
    ).toEqual({ retry: false });
  });
});
