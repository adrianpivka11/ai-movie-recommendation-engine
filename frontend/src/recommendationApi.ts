import type { AgenticStructuredData, FormAnswers, MoviesFromServer, SeriesFromServer } from "./types";

const POLL_INTERVAL_MS = 2000;
const REQUEST_DEADLINE_MS = 300000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMovie(value: unknown): value is MoviesFromServer {
  return isRecord(value) && typeof value.title === "string" &&
    typeof value.year === "string" && typeof value.poster_path === "string" &&
    typeof value.index === "number" && typeof value.isLast === "boolean" &&
    typeof value.recommendation === "string";
}

function isSeries(value: unknown): value is SeriesFromServer {
  return isRecord(value) && typeof value.title === "string" &&
    (value.year === null || typeof value.year === "number") &&
    typeof value.recommendation === "string";
}

function parseResult(value: unknown): AgenticStructuredData {
  if (!isRecord(value) || !Array.isArray(value.movies) || !value.movies.every(isMovie) ||
      !Array.isArray(value.series) || !value.series.every(isSeries)) {
    throw new Error("Server returned an invalid recommendation result.");
  }
  return { movies: value.movies, series: value.series };
}

/** Read error responses defensively: proxies can return HTML or an empty body. */
async function readResponse(response: Response): Promise<Record<string, unknown>> {
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = isRecord(data) && typeof data.error === "string" ? data.error :
      `Request failed (HTTP ${response.status}). Please try again later.`;
    throw new Error(message);
  }
  if (!isRecord(data)) throw new Error("Server returned an invalid JSON response.");
  return data;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Submit once, then poll using the per-job bearer token kept only in memory. */
export async function requestRecommendations(
  answers: FormAnswers,
  signal: AbortSignal,
): Promise<AgenticStructuredData> {
  const baseUrl = (import.meta.env.VITE_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (import.meta.env.PROD && !baseUrl) {
    throw new Error("API address is not configured. Set VITE_API_BASE_URL and rebuild the frontend.");
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.throwIfAborted();
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(
    "Recommendations are taking too long. Processing may still continue in the background. Please try again later."
  )), REQUEST_DEADLINE_MS);

  try {
    // Never retry POST automatically: it could create another paid AI job.
    const response = await fetch(`${baseUrl}/api/recommend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(answers),
      signal: controller.signal,
    });
    const data = await readResponse(response);
    // The local Express backend still returns recommendations synchronously.
    if (response.status !== 202) return parseResult(data.agenticStructuredData);
    if (typeof data.jobId !== "string" || !data.jobId ||
        typeof data.accessToken !== "string" || !data.accessToken) {
      throw new Error("Server returned an invalid job response.");
    }

    let transientFailures = 0;
    while (true) {
      controller.signal.throwIfAborted();
      const statusResponse = await fetch(`${baseUrl}/api/jobs/${encodeURIComponent(data.jobId)}`, {
        headers: { Authorization: `Bearer ${data.accessToken}` },
        cache: "no-store",
        signal: controller.signal,
      });
      if ([429, 502, 503, 504].includes(statusResponse.status) && transientFailures < 3) {
        transientFailures++;
        await wait(POLL_INTERVAL_MS * transientFailures, controller.signal);
        continue;
      }
      const job = await readResponse(statusResponse);
      transientFailures = 0;
      if (job.jobId !== data.jobId) throw new Error("Server returned an invalid job response.");
      switch (job.status) {
        case "completed": return parseResult(job.result);
        case "failed": throw new Error(typeof job.error === "string" ? job.error : "Recommendation failed. Please try again later.");
        case "queued":
        case "processing": await wait(POLL_INTERVAL_MS, controller.signal); break;
        default: throw new Error("Server returned an invalid job status.");
      }
    }
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof TypeError) {
      throw new Error("Cannot reach the recommendation service. Check your connection and try again.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}
