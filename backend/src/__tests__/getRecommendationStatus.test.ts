import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGetRecommendationStatusHandler, handler } from "../handlers/getRecommendationStatus.js";
import { createSubmitRecommendationHandler } from "../handlers/submitRecommendation.js";
import { createJobAccess, hashJobAccessToken } from "../jobs/access.js";
import type { RecommendationJobRow } from "../jobs/types.js";

const id = "67d2bb4f-3c69-49b5-9ef7-0f58c70ac179";
const access = createJobAccess();
const row: RecommendationJobRow = {
  id, query: "Private query", status: "queued", result: null, error: "Private diagnostic",
  attempt_count: 1, lock_token: "6b56d9e2-5c26-40e3-8b34-d27c44f435fc",
  locked_until: "2026-11-11T00:05:00Z", started_at: null, completed_at: null,
  created_at: "2026-11-11T00:00:00Z", updated_at: "2026-11-11T00:00:00Z",
};
const result = { movies: [{ title: "Arrival", year: "2016", poster_path: "/arrival.jpg",
  index: 0, isLast: true, recommendation: "Thoughtful science fiction." }],
  series: [{ title: "Dark", year: 2017, recommendation: "A mystery." }] };
const getAuthorizedJob = vi.fn();
const load = vi.fn();
const status = createGetRecommendationStatusHandler(load);
function event(): APIGatewayProxyEventV2 {
  return {
    version: "2.0", routeKey: "GET /api/jobs/{jobId}", rawPath: `/api/jobs/${id}`,
    rawQueryString: "", isBase64Encoded: false,
    pathParameters: { jobId: id }, headers: { authorization: `Bearer ${access.accessToken}` },
    requestContext: {
      accountId: "test", apiId: "test", domainName: "localhost", domainPrefix: "test",
      requestId: "test", routeKey: "GET /api/jobs/{jobId}", stage: "$default", time: "", timeEpoch: 0,
      http: { method: "GET", path: `/api/jobs/${id}`, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  load.mockResolvedValue({ getAuthorizedJob });
  getAuthorizedJob.mockResolvedValue(row);
});
afterEach(() => vi.restoreAllMocks());

describe("job status Lambda", () => {
  it.each(["queued", "processing"])("returns only jobId and %s status", async (state) => {
    getAuthorizedJob.mockResolvedValue({ ...row, status: state });
    const response = await status(event());
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body!)).toEqual({ jobId: id, status: state });
    expect(response.headers?.["cache-control"]).toBe("no-store");
    expect(getAuthorizedJob).toHaveBeenCalledExactlyOnceWith(id, access.accessTokenHash);
  });

  it("returns completed movies/series with no internal fields, even inside results", async () => {
    getAuthorizedJob.mockResolvedValue({ ...row, status: "completed", access_token_hash: access.accessTokenHash,
      result: { ...result, lock_token: "secret", movies: [{ ...result.movies[0], internalError: "secret" }] } });
    const response = await status(event());
    expect(JSON.parse(response.body!)).toEqual({ jobId: id, status: "completed", result });
    expect(response.body).not.toContain("secret");
    expect(response.body).not.toContain(access.accessToken);
    expect(response.body).not.toContain(access.accessTokenHash);
  });

  it.each([null, "Raw provider error with secret", "Recommendation could not be queued."])(
    "always returns fixed safe text for failed jobs (%#)", async (error) => {
      getAuthorizedJob.mockResolvedValue({ ...row, status: "failed", error });
      const response = await status(event());
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body!)).toEqual({ jobId: id, status: "failed",
        error: "Recommendation could not be completed. Please try again." });
    });

  it.each([undefined, "invalid", ""]) ("rejects invalid IDs before loading dependencies (%#)", async (jobId) => {
    const request = event();
    request.pathParameters = { jobId };
    expect((await status(request)).statusCode).toBe(400);
    expect(load).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "Basic abc", "Bearer invalid", `Bearer ${"a".repeat(64)}`,
    `Bearer ${access.accessToken}, Bearer ${access.accessToken}`])("rejects absent/malformed credentials (%#)", async (authorization) => {
      const request = event();
      request.headers = { authorization };
      const response = await status(request);
      expect(response.statusCode).toBe(401);
      expect(response.headers?.["www-authenticate"]).toBe("Bearer");
      expect(load).not.toHaveBeenCalled();
    });

  it("rejects ambiguous duplicate headers but accepts case-insensitive header/scheme", async () => {
    const request = event();
    request.headers.Authorization = request.headers.authorization;
    expect((await status(request)).statusCode).toBe(401);
    request.headers = { Authorization: `bearer ${access.accessToken}` };
    expect((await status(request)).statusCode).toBe(200);
  });

  it("does not accept credentials in the URL", async () => {
    const request = event();
    request.headers = {};
    request.queryStringParameters = { accessToken: access.accessToken };
    expect((await status(request)).statusCode).toBe(401);
    expect(load).not.toHaveBeenCalled();
  });

  it("returns the same 404 for a missing job or a well-formed wrong token", async () => {
    getAuthorizedJob.mockResolvedValue(null);
    const missing = await status(event());
    const other = event();
    other.headers.authorization = `Bearer ${createJobAccess().accessToken}`;
    expect(await status(other)).toEqual(missing);
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(missing.body!)).toEqual({ error: "Job not found." });
  });

  it("does not expose or log internal read errors or access tokens", async () => {
    getAuthorizedJob.mockRejectedValue(new Error(`Sensitive ${access.accessToken}`));
    const response = await status(event());
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("Sensitive");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(access.accessToken);
  });

  it("handles missing configuration with safe 503", async () => {
    load.mockRejectedValue(new Error("Missing SUPABASE_API_KEY"));
    const response = await status(event());
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("SUPABASE");
  });

  it("rejects invalid stored results instead of exposing them", async () => {
    getAuthorizedJob.mockResolvedValue({ ...row, status: "completed", result: { secret: "internal" } });
    const response = await status(event());
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("internal");
  });

  it("checks method and validates before loading production providers", async () => {
    const request = event();
    request.requestContext.http.method = "POST";
    expect((await status(request)).statusCode).toBe(405);
    request.requestContext.http.method = "GET";
    request.headers = {};
    expect((await handler(request)).statusCode).toBe(401);
    expect(load).not.toHaveBeenCalled();
  });

  it("connects submit credentials to status access without allowing cross-job reads", async () => {
    const stored = new Map<string, string>();
    const ids = [id, "6b56d9e2-5c26-40e3-8b34-d27c44f435fc"];
    const submit = createSubmitRecommendationHandler(async () => ({
      createJob: async (_query, hash) => {
        const jobId = ids[stored.size];
        stored.set(jobId, hash);
        return { ...row, id: jobId };
      },
      sendJob: async () => {}, failUnsubmittedJob: async () => null,
    }));
    const post = { body: JSON.stringify({ movieOrSerieUserRequest: "Movies" }),
      requestContext: { http: { method: "POST" } } } as APIGatewayProxyEventV2;
    const first = JSON.parse((await submit(post)).body!);
    const second = JSON.parse((await submit(post)).body!);
    expect(stored.get(first.jobId)).toBe(hashJobAccessToken(first.accessToken));
    getAuthorizedJob.mockImplementation(async (jobId, hash) => stored.get(jobId) === hash ? { ...row, id: jobId } : null);
    const request = event();
    request.headers.authorization = `Bearer ${first.accessToken}`;
    expect((await status(request)).statusCode).toBe(200);
    request.pathParameters = { jobId: second.jobId };
    expect((await status(request)).statusCode).toBe(404);
    request.headers.authorization = `Bearer ${second.accessToken}`;
    expect((await status(request)).statusCode).toBe(200);
  });
});
