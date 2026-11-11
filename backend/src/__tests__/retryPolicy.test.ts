import { describe, expect, it } from "vitest";
import { isRetryableRecommendationError as retryable } from "../jobs/retryPolicy.js";

describe("recommendation retry policy", () => {
  it.each([408, 429, 500, 502, 503, 504])("retries transient HTTP %s", (statusCode) => {
    expect(retryable({ statusCode })).toBe(true);
  });
  it.each([400, 401, 403, 404, 422])("does not retry HTTP %s", (status) => {
    expect(retryable({ status })).toBe(false);
  });
  it.each(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "40001", "40P01", "08006"])(
    "retries network/database error %s", (code) => expect(retryable({ cause: { code } })).toBe(true));
  it("unwraps SDK retry errors and checks provider quota before HTTP 429", () => {
    expect(retryable({ lastError: { statusCode: 503 } })).toBe(true);
    expect(retryable({ statusCode: 429, responseBody: JSON.stringify({ error: { code: "insufficient_quota" } }) })).toBe(false);
  });
  it("retries aggregates only if all errors are transient", () => {
    expect(retryable(new AggregateError([{ statusCode: 503 }, { statusCode: 429 }]))).toBe(true);
    expect(retryable(new AggregateError([{ statusCode: 503 }, { statusCode: 401 }]))).toBe(false);
  });
  it("does not guess from messages or loop over circular causes", () => {
    expect(retryable(new Error("timeout 503 429"))).toBe(false);
    const error: { cause?: unknown } = {};
    error.cause = error;
    expect(retryable(error)).toBe(false);
  });
});
