import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestRecommendations } from "../recommendationApi";

const answers = { movieOrSerieUserRequest: "Recommend a thriller" };
const accepted = { jobId: "job-123", accessToken: "private-token" };
const result = { movies: [], series: [{ title: "Dark", year: 2017, recommendation: "A mystery." }] };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const completed = () => response({ jobId: accepted.jobId, status: "completed", result });

beforeEach(() => {
  vi.stubEnv("VITE_API_BASE_URL", "https://example.execute-api.eu-north-1.amazonaws.com/");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("recommendation API", () => {
  it("submits once to the configured API and polls with a bearer token", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(accepted, 202))
      .mockResolvedValueOnce(response({ jobId: accepted.jobId, status: "queued" }))
      .mockResolvedValueOnce(response({ jobId: accepted.jobId, status: "processing" }))
      .mockResolvedValueOnce(completed());
    vi.stubGlobal("fetch", fetchMock);
    const pending = requestRecommendations(answers, new AbortController().signal);
    const check = expect(pending).resolves.toEqual(result);
    await vi.advanceTimersByTimeAsync(4000);
    await check;
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenNthCalledWith(1,
      "https://example.execute-api.eu-north-1.amazonaws.com/api/recommend",
      expect.objectContaining({ method: "POST", body: JSON.stringify(answers) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2,
      "https://example.execute-api.eu-north-1.amazonaws.com/api/jobs/job-123",
      expect.objectContaining({ headers: { Authorization: "Bearer private-token" }, cache: "no-store" }));
  });

  it("supports the synchronous local Express response", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ agenticStructuredData: result })));
    await expect(requestRecommendations(answers, new AbortController().signal)).resolves.toEqual(result);
    expect(fetch).toHaveBeenCalledWith("/api/recommend", expect.anything());
  });

  it("rejects missing production configuration before sending a request", async () => {
    vi.stubEnv("PROD", true);
    vi.stubEnv("VITE_API_BASE_URL", "");
    vi.stubGlobal("fetch", vi.fn());
    await expect(requestRecommendations(answers, new AbortController().signal)).rejects.toThrow("VITE_API_BASE_URL");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows an HTTP error for an empty response rather than a JSON parser error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 405 })));
    await expect(requestRecommendations(answers, new AbortController().signal)).rejects.toThrow("HTTP 405");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("exposes the safe failed-job message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(accepted, 202))
      .mockResolvedValueOnce(response({ jobId: accepted.jobId, status: "failed", error: "Please try again later." })));
    await expect(requestRecommendations(answers, new AbortController().signal)).rejects.toThrow("Please try again later.");
  });

  it.each([401, 403, 404])("stops polling after HTTP %s", async status => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(accepted, 202))
      .mockResolvedValueOnce(response({ error: "Job unavailable" }, status)));
    await expect(requestRecommendations(answers, new AbortController().signal)).rejects.toThrow("Job unavailable");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries transient GET failures without resubmitting the job", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(accepted, 202))
      .mockResolvedValueOnce(new Response(null, { status: 429 })).mockResolvedValueOnce(completed()));
    const check = expect(requestRecommendations(answers, new AbortController().signal)).resolves.toEqual(result);
    await vi.advanceTimersByTimeAsync(2000);
    await check;
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("cancels polling during the delay", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(accepted, 202))
      .mockImplementation(async () => response({ jobId: accepted.jobId, status: "queued" })));
    const check = expect(requestRecommendations(answers, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await check;
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("limits waiting time even when jobs remain queued", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(accepted, 202))
      .mockImplementation(async () => response({ jobId: accepted.jobId, status: "queued" })));
    const check = expect(requestRecommendations(answers, new AbortController().signal)).rejects.toThrow("taking too long");
    await vi.advanceTimersByTimeAsync(300000);
    await check;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects malformed completion data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(accepted, 202))
      .mockResolvedValueOnce(response({ jobId: accepted.jobId, status: "completed", result: { movies: [{}], series: [] } })));
    await expect(requestRecommendations(answers, new AbortController().signal)).rejects.toThrow("invalid recommendation result");
  });
});
