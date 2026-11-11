import type { SQSEvent, SQSRecord } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProcessRecommendationHandler, handler } from "../handlers/processRecommendation.js";
import type { RecommendationJobRow } from "../jobs/types.js";

const id = "67d2bb4f-3c69-49b5-9ef7-0f58c70ac179";
const token = "6b56d9e2-5c26-40e3-8b34-d27c44f435fc";
const result = { movies: [], series: [] };
const processing: RecommendationJobRow = {
  id, query: "Recommend movies", status: "processing", result: null, error: null,
  attempt_count: 1, lock_token: token, locked_until: "2026-11-11T00:05:00Z",
  created_at: "2026-11-11T00:00:00Z", updated_at: "2026-11-11T00:00:00Z",
  started_at: "2026-11-11T00:00:00Z", completed_at: null,
};
const completed = { ...processing, status: "completed", result };
const failed = { ...processing, status: "failed", error: "Safe message" };
const db = {
  claimJob: vi.fn(), getJob: vi.fn(), completeJob: vi.fn(),
  failJob: vi.fn(), retryJob: vi.fn(), recommend: vi.fn(),
};
const load = vi.fn();
const context = { getRemainingTimeInMillis: vi.fn() };
const worker = createProcessRecommendationHandler(load);
const failure = { batchItemFailures: [{ itemIdentifier: "message-1" }] };
function event(body = JSON.stringify({ jobId: id })): SQSEvent {
  return { Records: [{ messageId: "message-1", body } as SQSRecord] };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  context.getRemainingTimeInMillis.mockReturnValue(230_000);
  load.mockResolvedValue(db);
  db.claimJob.mockResolvedValue(processing);
  db.getJob.mockResolvedValue(processing);
  db.completeJob.mockResolvedValue(completed);
  db.failJob.mockResolvedValue(failed);
  db.retryJob.mockResolvedValue({ ...processing, status: "queued" });
  db.recommend.mockResolvedValue(result);
});
afterEach(() => vi.restoreAllMocks());

describe("recommendation worker", () => {
  it("claims with bounded attempts, calls the router using the DB query, and completes with its token", async () => {
    expect(await worker(event(), context)).toEqual({ batchItemFailures: [] });
    expect(db.claimJob).toHaveBeenCalledExactlyOnceWith(id, { leaseSeconds: 300, maxAttempts: 3 });
    expect(db.recommend).toHaveBeenCalledExactlyOnceWith(processing.query);
    expect(db.completeJob).toHaveBeenCalledExactlyOnceWith(id, token, result);
  });

  it.each(["completed", "failed"])("acknowledges duplicate/exhausted %s jobs without paid calls", async (status) => {
    db.claimJob.mockResolvedValue(null);
    db.getJob.mockResolvedValue({ ...processing, status });
    expect(await worker(event(), context)).toEqual({ batchItemFailures: [] });
    expect(db.recommend).not.toHaveBeenCalled();
  });

  it.each([processing, { ...processing, status: "queued" }, null])("keeps busy/queued/missing jobs for redelivery (%#)", async (row) => {
    db.claimJob.mockResolvedValue(null);
    db.getJob.mockResolvedValue(row);
    expect(await worker(event(), context)).toEqual(failure);
    expect(db.recommend).not.toHaveBeenCalled();
  });

  it("does not process concurrent duplicate deliveries under the same live lease", async () => {
    let finish!: (value: typeof result) => void;
    db.recommend.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    db.claimJob.mockResolvedValueOnce(processing).mockResolvedValue(null);
    const first = worker(event(), context);
    await vi.waitFor(() => expect(db.recommend).toHaveBeenCalledTimes(1));
    expect(await worker(event(), context)).toEqual(failure);
    expect(db.recommend).toHaveBeenCalledTimes(1);
    finish(result);
    expect(await first).toEqual({ batchItemFailures: [] });
  });

  it("requeues transient failure and lets SQS handle redelivery", async () => {
    db.recommend.mockRejectedValue({ statusCode: 503 });
    expect(await worker(event(), context)).toEqual(failure);
    expect(db.retryJob).toHaveBeenCalledExactlyOnceWith(id, token);
    expect(db.failJob).not.toHaveBeenCalled();
    expect(db.recommend).toHaveBeenCalledTimes(1);
  });

  it("marks the last transient attempt failed instead of scheduling more AI work", async () => {
    db.claimJob.mockResolvedValue({ ...processing, attempt_count: 3 });
    db.recommend.mockRejectedValue({ statusCode: 429 });
    expect(await worker(event(), context)).toEqual({ batchItemFailures: [] });
    expect(db.failJob).toHaveBeenCalledExactlyOnceWith(id, token,
      "Recommendation could not be completed after repeated attempts.");
    expect(db.retryJob).not.toHaveBeenCalled();
  });

  it("stops paid work after three failed attempts across repeated deliveries", async () => {
    db.claimJob.mockResolvedValueOnce({ ...processing, attempt_count: 1 })
      .mockResolvedValueOnce({ ...processing, attempt_count: 2 })
      .mockResolvedValueOnce({ ...processing, attempt_count: 3 })
      .mockResolvedValue(null);
    db.getJob.mockResolvedValue(failed);
    db.recommend.mockRejectedValue({ statusCode: 503 });
    expect(await worker(event(), context)).toEqual(failure);
    expect(await worker(event(), context)).toEqual(failure);
    expect(await worker(event(), context)).toEqual({ batchItemFailures: [] });
    expect(await worker(event(), context)).toEqual({ batchItemFailures: [] });
    expect(db.recommend).toHaveBeenCalledTimes(3);
    expect(db.retryJob).toHaveBeenCalledTimes(2);
    expect(db.failJob).toHaveBeenCalledTimes(1);
  });

  it.each([{ statusCode: 401 }, { statusCode: 400 }, new Error("secret provider error"),
    { statusCode: 429, data: { error: { code: "insufficient_quota" } } }])(
    "makes permanent/unknown errors terminal with safe public text (%#)", async (error) => {
      db.recommend.mockRejectedValue(error);
      expect(await worker(event(), context)).toEqual({ batchItemFailures: [] });
      expect(db.failJob).toHaveBeenCalledExactlyOnceWith(id, token,
        "Recommendation could not be completed. Please try again.");
      expect(db.retryJob).not.toHaveBeenCalled();
    });

  it("rejects malformed router output without a completion write or paid retry", async () => {
    db.recommend.mockResolvedValue({ movies: "invalid", series: [] });
    expect(await worker(event(), context)).toEqual({ batchItemFailures: [] });
    expect(db.completeJob).not.toHaveBeenCalled();
    expect(db.failJob).toHaveBeenCalled();
  });

  it("does not treat a rejected completion (lost/expired token) as success", async () => {
    db.completeJob.mockResolvedValue(null);
    expect(await worker(event(), context)).toEqual(failure);
    expect(db.failJob).not.toHaveBeenCalled();
    expect(db.retryJob).not.toHaveBeenCalled();
  });

  it("does not overwrite an uncertain completion; redelivery sees the committed result", async () => {
    db.completeJob.mockRejectedValueOnce(new Error("Lost DB acknowledgement"));
    expect(await worker(event(), context)).toEqual(failure);
    db.claimJob.mockResolvedValue(null);
    db.getJob.mockResolvedValue(completed);
    expect(await worker(event(), context)).toEqual({ batchItemFailures: [] });
    expect(db.recommend).toHaveBeenCalledTimes(1);
    expect(db.failJob).not.toHaveBeenCalled();
    expect(db.retryJob).not.toHaveBeenCalled();
  });

  it.each(["retryJob", "failJob"] as const)("retains message if %s rejects ownership", async (method) => {
    db.recommend.mockRejectedValue({ statusCode: method === "retryJob" ? 503 : 401 });
    db[method].mockResolvedValue(null);
    expect(await worker(event(), context)).toEqual(failure);
  });

  it.each(["claimJob", "getJob", "completeJob", "retryJob", "failJob"] as const)(
    "retains messages on %s database failure", async (method) => {
      if (method === "getJob") db.claimJob.mockResolvedValue(null);
      if (method === "retryJob") db.recommend.mockRejectedValue({ statusCode: 503 });
      if (method === "failJob") db.recommend.mockRejectedValue({ statusCode: 401 });
      db[method].mockRejectedValue(new Error("DB unavailable"));
      expect(await worker(event(), context)).toEqual(failure);
    });

  it.each(["{bad", "null", "{}", '{"jobId":"invalid"}', JSON.stringify({ jobId: id, query: "untrusted" })])(
    "retains invalid messages for DLQ without loading providers (%#)", async (body) => {
      expect(await worker(event(body), context)).toEqual(failure);
      expect(load).not.toHaveBeenCalled();
    });

  it("production entrypoint also rejects invalid input before importing providers", async () => {
    expect(await handler(event("null"), context)).toEqual(failure);
  });

  it("reports only unsuccessful message IDs in a mixed batch", async () => {
    const batch = event();
    batch.Records.push({ messageId: "bad-message", body: "invalid" } as SQSRecord);
    expect(await worker(batch, context)).toEqual({ batchItemFailures: [{ itemIdentifier: "bad-message" }] });
  });

  it.each([20_000, 241_000])("does not claim work with unsafe remaining runtime %s", async (remaining) => {
    context.getRemainingTimeInMillis.mockReturnValue(remaining);
    expect(await worker(event(), context)).toEqual(failure);
    expect(load).not.toHaveBeenCalled();
  });

  it("does not run AI for an invalid claimed lease", async () => {
    db.claimJob.mockResolvedValue({ ...processing, lock_token: null });
    expect(await worker(event(), context)).toEqual(failure);
    expect(db.recommend).not.toHaveBeenCalled();
  });
});
