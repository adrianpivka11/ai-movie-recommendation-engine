import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createSubmitRecommendationHandler, handler } from "../handlers/submitRecommendation.js";
import type { RecommendationJobRow } from "../jobs/types.js";
import { hashJobAccessToken } from "../jobs/access.js";

const id = "67d2bb4f-3c69-49b5-9ef7-0f58c70ac179";
const row: RecommendationJobRow = {
  id, query: "Movies", status: "queued", result: null, error: null, attempt_count: 0,
  lock_token: null, locked_until: null, started_at: null, completed_at: null,
  created_at: "2026-11-11T00:00:00Z", updated_at: "2026-11-11T00:00:00Z",
};
const createJob = vi.fn();
const sendJob = vi.fn();
const failUnsubmittedJob = vi.fn();
const load = vi.fn();
const submit = createSubmitRecommendationHandler(load);
function event(body = JSON.stringify({ movieOrSerieUserRequest: "  Movies  " }), encoded = false) {
  return { body, isBase64Encoded: encoded, requestContext: { http: { method: "POST" } } } as APIGatewayProxyEventV2;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  createJob.mockResolvedValue(row);
  sendJob.mockResolvedValue(undefined);
  failUnsubmittedJob.mockResolvedValue({ ...row, status: "failed" });
  load.mockResolvedValue({ createJob, sendJob, failUnsubmittedJob });
});
afterEach(() => vi.restoreAllMocks());

describe("submit recommendation Lambda", () => {
  it("stores trimmed input then sends only the job ID and returns 202", async () => {
    const result = await submit(event());
    const body = JSON.parse(result.body!);
    expect(body.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createJob).toHaveBeenCalledExactlyOnceWith("Movies", hashJobAccessToken(body.accessToken));
    expect(sendJob).toHaveBeenCalledExactlyOnceWith(id);
    expect(createJob.mock.invocationCallOrder[0]).toBeLessThan(sendJob.mock.invocationCallOrder[0]);
    expect(result.statusCode).toBe(202);
    expect(body).toEqual({ jobId: id, accessToken: expect.any(String) });
    expect(result.headers?.["cache-control"]).toBe("no-store");
    expect(failUnsubmittedJob).not.toHaveBeenCalled();
  });

  it("does not acknowledge before SQS confirms acceptance", async () => {
    let confirm!: () => void;
    sendJob.mockReturnValue(new Promise<void>((resolve) => { confirm = resolve; }));
    let finished = false;
    const pending = submit(event()).then((result) => { finished = true; return result; });
    await vi.waitFor(() => expect(sendJob).toHaveBeenCalled());
    expect(finished).toBe(false);
    confirm();
    expect((await pending).statusCode).toBe(202);
  });

  it("supports base64 bodies from API Gateway", async () => {
    expect((await submit(event(Buffer.from(event().body!).toString("base64"), true))).statusCode).toBe(202);
  });

  it.each(["", "{bad", "null", "[]", "{}", '{"movieOrSerieUserRequest":42}',
    '{"movieOrSerieUserRequest":"  "}', JSON.stringify({ movieOrSerieUserRequest: "a".repeat(10001) }),
    " ".repeat(100001)])("rejects invalid input without external side effects (%#)", async (body) => {
    expect((await submit(event(body))).statusCode).toBe(400);
    expect(load).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
  });

  it("rejects other methods", async () => {
    const request = event();
    request.requestContext.http.method = "GET";
    expect((await submit(request)).statusCode).toBe(405);
    expect(load).not.toHaveBeenCalled();
  });

  it("validates before loading real provider configuration", async () => {
    expect((await handler(event("null"))).statusCode).toBe(400);
  });

  it("does not create a row when configuration fails", async () => {
    load.mockRejectedValue(new Error("Missing queue URL"));
    expect((await submit(event())).statusCode).toBe(503);
    expect(createJob).not.toHaveBeenCalled();
  });

  it("does not send when Supabase fails and hides provider details", async () => {
    createJob.mockRejectedValue(new Error("secret DB diagnostic"));
    const result = await submit(event());
    expect(result.statusCode).toBe(503);
    expect(result.body).not.toContain("secret");
    expect(sendJob).not.toHaveBeenCalled();
    expect(failUnsubmittedJob).not.toHaveBeenCalled();
  });

  it("compensates a failed or uncertain SQS send with safe text", async () => {
    sendJob.mockRejectedValue(new Error("secret timeout"));
    const result = await submit(event());
    expect(result.statusCode).toBe(503);
    expect(failUnsubmittedJob).toHaveBeenCalledExactlyOnceWith(id,
      "Recommendation could not be queued. Please submit a new request.");
    expect(result.body).not.toContain("secret");
    expect(JSON.parse(result.body!)).not.toHaveProperty("jobId");
    expect(JSON.parse(result.body!)).not.toHaveProperty("accessToken");
  });

  it("does not overwrite a job already claimed after an uncertain send", async () => {
    sendJob.mockRejectedValue(new Error("Lost acknowledgement"));
    failUnsubmittedJob.mockResolvedValue(null);
    expect((await submit(event())).statusCode).toBe(503);
    expect(failUnsubmittedJob).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalled();
  });

  it("logs reconciliation details if both queue and compensation fail", async () => {
    sendJob.mockRejectedValue(new Error("SQS offline"));
    const error = new Error("DB offline");
    failUnsubmittedJob.mockRejectedValue(error);
    expect((await submit(event())).statusCode).toBe(503);
    expect(console.error).toHaveBeenCalledWith("[Submit Job] RECONCILIATION_REQUIRED", { jobId: id, error });
  });
});
