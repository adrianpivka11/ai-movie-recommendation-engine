/** Retry only recognized transient failures; unknown errors must not repeat paid work. */
export function isRetryableRecommendationError(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 8) return false;
  const value = error as Record<string, unknown>;
  // Both tools may fail. A permanent failure in either makes retrying both wasteful.
  if (Array.isArray(value.errors) && value.errors.length > 0) {
    return value.errors.every((item) => isRetryableRecommendationError(item, depth + 1));
  }
  // AI SDK retry wrappers retain the final provider error.
  if (value.lastError) return isRetryableRecommendationError(value.lastError, depth + 1);

  let data = value.data;
  if (!data && typeof value.responseBody === "string") {
    try { data = JSON.parse(value.responseBody); } catch { /* Not a JSON provider response. */ }
  }
  const provider = data && typeof data === "object"
    ? (data as { error?: { code?: string; type?: string } }).error : undefined;
  const code = provider?.code ?? provider?.type ?? value.code;
  if (["insufficient_quota", "billing_hard_limit_reached", "invalid_api_key",
    "context_length_exceeded", "model_not_found"].includes(String(code))) return false;
  const status = value.statusCode ?? value.status;
  if (typeof status === "number") {
    return status === 408 || status === 429 || (status >= 500 && status <= 599);
  }
  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET", "40001", "40P01", "53300", "57P01"].includes(String(code))) return true;
  if (typeof code === "string" && /^08[0-9A-Z]{3}$/.test(code)) return true;
  if (value.name === "TimeoutError") return true;
  return isRetryableRecommendationError(value.cause, depth + 1);
}
