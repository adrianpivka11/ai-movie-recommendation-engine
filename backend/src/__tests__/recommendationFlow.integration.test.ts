import { randomUUID } from "node:crypto";
import type { APIGatewayProxyEventV2, SQSEvent } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler as submit } from "../handlers/submitRecommendation.js";
import { handler as processJob } from "../handlers/processRecommendation.js";
import { handler as getStatus } from "../handlers/getRecommendationStatus.js";
import { recommendationJobRowSchema } from "../jobs/schemas.js";
import type { RecommendationJobRow } from "../jobs/types.js";

const mocks = vi.hoisted(() => ({
  createRecommendationJob: vi.fn(), getRecommendationJob: vi.fn(),
  getAuthorizedRecommendationJob: vi.fn(), claimRecommendationJob: vi.fn(),
  completeRecommendationJob: vi.fn(), failRecommendationJob: vi.fn(),
  retryRecommendationJob: vi.fn(), failUnsubmittedRecommendationJob: vi.fn(),
  send: vi.fn(), rag: vi.fn(), search: vi.fn(),
}));
vi.mock("../jobs/repository.js", () => mocks);
vi.mock("../rag.js", () => ({ retrieveSimilarMoviesByRAG: mocks.rag }));
vi.mock("../seriesWebSearch.js", () => ({ webSearchTool: mocks.search }));
vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: class { send = mocks.send; },
  SendMessageCommand: class { constructor(public input: { QueueUrl: string; MessageBody: string }) {} },
}));

// Real Lambda entrypoints, token handling, SQS serialization, router and retry
// policy share one flow. Only external boundaries are simulated. This in-memory
// repository is NOT a replacement for the separate PostgreSQL locking tests.
type StoredJob = RecommendationJobRow & { access_token_hash: string };
const jobs = new Map<string, StoredJob>();
const messages: SQSEvent["Records"] = [];
const context = { getRemainingTimeInMillis: () => 230_000 };
const now = "2026-11-11T12:00:00.000Z";
const movies = [{ title: "Arrival", year: "2016", poster_path: "/arrival.jpg",
  index: 0, isLast: true, recommendation: "Thoughtful science fiction." }];
const series = [{ title: "Dark", year: 2017, recommendation: "A mystery series." }];

function http(method: "GET" | "POST", jobId?: string, token?: string): APIGatewayProxyEventV2 {
  const path = method === "POST" ? "/api/recommend" : `/api/jobs/${jobId}`;
  return {
    version: "2.0", routeKey: `${method} ${path}`, rawPath: path, rawQueryString: "",
    isBase64Encoded: false, pathParameters: { jobId },
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: method === "POST" ? JSON.stringify({ movieOrSerieUserRequest: "  Recommend movies and series  " }) : undefined,
    requestContext: {
      accountId: "test", apiId: "test", domainName: "localhost", domainPrefix: "test",
      requestId: "test", routeKey: `${method} ${path}`, stage: "$default", time: "", timeEpoch: 0,
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "vitest" },
    },
  };
}

/** Persist a snapshot so callers cannot accidentally mutate the shared database. */
function save(row: StoredJob, changes: Record<string, unknown>): StoredJob {
  const updated = { ...recommendationJobRowSchema.parse({ ...row, ...changes }), access_token_hash: row.access_token_hash };
  jobs.set(row.id, updated);
  return structuredClone(updated);
}

function finish(id: string, token: string, changes: Record<string, unknown>) {
  const row = jobs.get(id);
  if (!row || row.status !== "processing" || row.lock_token !== token) return null;
  return save(row, { ...changes, lock_token: null, locked_until: null });
}

beforeEach(() => {
  vi.resetAllMocks();
  jobs.clear();
  messages.length = 0;
  vi.stubEnv("RECOMMENDATION_QUEUE_URL", "https://sqs.eu-central-1.amazonaws.com/123456789012/test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.rag.mockResolvedValue(movies);
  mocks.search.mockResolvedValue(series);

  mocks.createRecommendationJob.mockImplementation(async (query: string, hash: string) => {
    const row: StoredJob = {
      id: randomUUID(), query, access_token_hash: hash, status: "queued", result: null,
      error: null, attempt_count: 0, lock_token: null, locked_until: null,
      created_at: now, updated_at: now, started_at: null, completed_at: null,
    };
    jobs.set(row.id, row);
    return structuredClone(row);
  });
  mocks.getRecommendationJob.mockImplementation(async (id: string) => structuredClone(jobs.get(id) ?? null));
  mocks.getAuthorizedRecommendationJob.mockImplementation(async (id: string, hash: string) => {
    const row = jobs.get(id);
    return row?.access_token_hash === hash ? structuredClone(row) : null;
  });
  mocks.claimRecommendationJob.mockImplementation(async (id: string, options: { maxAttempts: number }) => {
    const row = jobs.get(id);
    if (!row || row.status !== "queued") return null;
    if (row.attempt_count >= options.maxAttempts) {
      save(row, { status: "failed", error: "Attempts exhausted." });
      return null;
    }
    return save(row, { status: "processing", attempt_count: row.attempt_count + 1,
      lock_token: randomUUID(), locked_until: "2026-11-11T12:05:00.000Z", started_at: now });
  });
  mocks.completeRecommendationJob.mockImplementation(async (id: string, token: string, result: unknown) =>
    finish(id, token, { status: "completed", result, completed_at: now }));
  mocks.failRecommendationJob.mockImplementation(async (id: string, token: string, error: string) =>
    finish(id, token, { status: "failed", error }));
  mocks.retryRecommendationJob.mockImplementation(async (id: string, token: string) =>
    finish(id, token, { status: "queued" }));
  mocks.failUnsubmittedRecommendationJob.mockImplementation(async (id: string, error: string) => {
    const row = jobs.get(id);
    return row?.status === "queued" && row.attempt_count === 0 ? save(row, { status: "failed", error }) : null;
  });
  mocks.send.mockImplementation(async (command: { input: { MessageBody: string } }) => {
    const messageId = randomUUID();
    messages.push({ messageId, body: command.input.MessageBody, receiptHandle: "test",
      attributes: { ApproximateReceiveCount: "1", SentTimestamp: "0", SenderId: "test", ApproximateFirstReceiveTimestamp: "0" },
      messageAttributes: {}, md5OfBody: "test", eventSource: "aws:sqs",
      eventSourceARN: "arn:aws:sqs:eu-central-1:123456789012:test", awsRegion: "eu-central-1" });
    return { MessageId: messageId };
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function submitJob() {
  const response = await submit(http("POST"));
  expect(response.statusCode).toBe(202);
  const body = JSON.parse(response.body!) as { jobId: string; accessToken: string };
  expect(body.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(messages).toHaveLength(1);
  expect(JSON.parse(messages[0].body)).toEqual({ jobId: body.jobId });
  return body;
}

describe("asynchronous recommendation flow integration", () => {
  it("runs POST -> queued -> SQS -> processing -> completed -> authorized GET and skips duplicates", async () => {
    const { jobId, accessToken } = await submitJob();
    const read = () => getStatus(http("GET", jobId, accessToken));
    expect(JSON.parse((await read()).body!)).toEqual({ jobId, status: "queued" });

    // Hold the mocked RAG call so the test can poll while the worker owns its lease.
    let resolveMovies!: (value: typeof movies) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    mocks.rag.mockImplementationOnce(() => {
      entered();
      return new Promise<typeof movies>((resolve) => { resolveMovies = resolve; });
    });
    const delivery = { Records: [...messages] };
    const running = processJob(delivery, context);
    try {
      await started;
      expect(JSON.parse((await read()).body!)).toEqual({ jobId, status: "processing" });
      expect(await processJob(delivery, context)).toEqual({ batchItemFailures: [{ itemIdentifier: messages[0].messageId }] });
    } finally {
      resolveMovies(movies);
      await running;
    }
    expect(await running).toEqual({ batchItemFailures: [] });
    const response = await read();
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body!)).toEqual({ jobId, status: "completed", result: { movies, series } });
    expect(response.headers?.["cache-control"]).toBe("no-store");
    expect((await getStatus(http("GET", jobId, "A".repeat(43)))).statusCode).toBe(404);
    expect(await processJob(delivery, context)).toEqual({ batchItemFailures: [] });
    expect(mocks.rag).toHaveBeenCalledExactlyOnceWith("Recommend movies and series");
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(jobs.get(jobId)?.attempt_count).toBe(1);
    expect(mocks.completeRecommendationJob).toHaveBeenCalledWith(jobId, expect.any(String), { movies, series });
  });

  it("redelivers a transient failure and exposes the successful second attempt", async () => {
    const { jobId, accessToken } = await submitJob();
    mocks.rag.mockRejectedValueOnce({ statusCode: 503 });
    const delivery = { Records: [...messages] };
    expect(await processJob(delivery, context)).toEqual({ batchItemFailures: [{ itemIdentifier: messages[0].messageId }] });
    expect(JSON.parse((await getStatus(http("GET", jobId, accessToken))).body!).status).toBe("queued");
    expect(await processJob(delivery, context)).toEqual({ batchItemFailures: [] });
    expect(JSON.parse((await getStatus(http("GET", jobId, accessToken))).body!)).toEqual({
      jobId, status: "completed", result: { movies, series },
    });
    expect(jobs.get(jobId)?.attempt_count).toBe(2);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("exposes a safe permanent failure and never reruns AI on its duplicate", async () => {
    const { jobId, accessToken } = await submitJob();
    mocks.rag.mockRejectedValueOnce({ statusCode: 401, message: "Private provider credential details" });
    const delivery = { Records: [...messages] };
    expect(await processJob(delivery, context)).toEqual({ batchItemFailures: [] });
    const response = await getStatus(http("GET", jobId, accessToken));
    expect(JSON.parse(response.body!)).toEqual({ jobId, status: "failed",
      error: "Recommendation could not be completed. Please try again." });
    expect(await processJob(delivery, context)).toEqual({ batchItemFailures: [] });
    expect(mocks.rag).toHaveBeenCalledTimes(1);
    expect(mocks.retryRecommendationJob).not.toHaveBeenCalled();
  });

  it("compensates a queue send failure without invoking the worker tools", async () => {
    mocks.send.mockRejectedValueOnce(new Error("SQS unavailable"));
    const response = await submit(http("POST"));
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body!)).not.toHaveProperty("accessToken");
    expect(messages).toHaveLength(0);
    expect(jobs.size).toBe(1);
    expect([...jobs.values()][0].status).toBe("failed");
    expect(mocks.rag).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("rejects invalid input without side effects and returns 404 for missing jobs", async () => {
    const request = http("POST");
    request.body = JSON.stringify({ movieOrSerieUserRequest: " " });
    expect((await submit(request)).statusCode).toBe(400);
    expect(jobs.size).toBe(0);
    expect(mocks.send).not.toHaveBeenCalled();
    expect((await getStatus(http("GET", randomUUID(), "A".repeat(43)))).statusCode).toBe(404);
    expect(mocks.rag).not.toHaveBeenCalled();
  });
});
