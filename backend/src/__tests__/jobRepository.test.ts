import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimRecommendationJob, completeRecommendationJob, createRecommendationJob,
  failRecommendationJob, getRecommendationJob, retryRecommendationJob,
  RecommendationJobRepositoryError, failUnsubmittedRecommendationJob, getAuthorizedRecommendationJob,
} from "../jobs/repository.js";

const db = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), insert: vi.fn(), select: vi.fn(), eq: vi.fn(),
  single: vi.fn(), maybeSingle: vi.fn(), update: vi.fn(),
}));
vi.mock("../supabaseClient.js", () => ({ supabase: db }));

const id = "67d2bb4f-3c69-49b5-9ef7-0f58c70ac179";
const token = "6b56d9e2-5c26-40e3-8b34-d27c44f435fc";
const hash = "a".repeat(64);
const now = "2026-11-10T20:00:00+00:00";
const result = { movies: [], series: [] };
const queuedRow = {
  id, query: "Recommend movies", status: "queued", result: null, error: null,
  attempt_count: 0, lock_token: null, locked_until: null,
  created_at: now, updated_at: now, started_at: null, completed_at: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  for (const method of [db.from, db.rpc, db.insert, db.select, db.eq, db.update]) {
    method.mockReturnValue(db);
  }
  db.single.mockResolvedValue({ data: queuedRow, error: null });
  db.maybeSingle.mockResolvedValue({ data: queuedRow, error: null });
});

describe("recommendation job repository", () => {
  it("compensates only queued jobs that were never claimed", async () => {
    const failed = { ...queuedRow, status: "failed", error: "Try again." };
    db.maybeSingle.mockResolvedValue({ data: failed, error: null });
    expect(await failUnsubmittedRecommendationJob(id, " Try again. ")).toEqual(failed);
    expect(db.update).toHaveBeenCalledExactlyOnceWith({ status: "failed", error: "Try again." });
    expect(db.eq.mock.calls).toEqual([["id", id], ["status", "queued"], ["attempt_count", 0]]);
  });

  it("distinguishes skipped compensation from database failure", async () => {
    db.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    expect(await failUnsubmittedRecommendationJob(id, "Try again.")).toBeNull();
    db.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "Offline" } });
    await expect(failUnsubmittedRecommendationJob(id, "Try again.")).rejects.toThrow(RecommendationJobRepositoryError);
  });

  it("creates a trimmed query using database defaults", async () => {
    expect(await createRecommendationJob("  Recommend movies  ", hash)).toEqual(queuedRow);
    expect(db.from).toHaveBeenCalledWith("recommendation_jobs");
    expect(db.insert).toHaveBeenCalledWith({ query: "Recommend movies", access_token_hash: hash });
  });

  it("rejects empty queries before writing", async () => {
    await expect(createRecommendationJob("  ", hash)).rejects.toThrow();
    expect(db.from).not.toHaveBeenCalled();
  });

  it("reads a job by ID", async () => {
    expect(await getRecommendationJob(id)).toEqual(queuedRow);
    expect(db.eq).toHaveBeenCalledWith("id", id);
  });

  it("distinguishes missing jobs from database errors", async () => {
    db.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    expect(await getRecommendationJob(id)).toBeNull();
    const cause = { code: "42501", message: "permission denied" };
    db.maybeSingle.mockResolvedValueOnce({ data: null, error: cause });
    await expect(getRecommendationJob(id)).rejects.toMatchObject({
      name: "RecommendationJobRepositoryError", cause,
    });
  });

  it("rejects invalid UUIDs before accessing the database", async () => {
    await expect(getRecommendationJob("invalid")).rejects.toThrow();
    await expect(claimRecommendationJob("invalid")).rejects.toThrow();
    await expect(completeRecommendationJob(id, "invalid", result)).rejects.toThrow();
    expect(db.from).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("uses one claim RPC and returns the database-generated lease", async () => {
    const processing = { ...queuedRow, status: "processing", lock_token: token,
      locked_until: "2026-11-10T20:05:00+00:00", started_at: now, attempt_count: 1 };
    db.maybeSingle.mockResolvedValue({ data: processing, error: null });
    expect(await claimRecommendationJob(id)).toEqual(processing);
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith("claim_recommendation_job", {
      p_job_id: id, p_lease_seconds: 300, p_max_attempts: 3,
    });
    expect(db.from).not.toHaveBeenCalled();
  });

  it("passes configured lease and attempt limits", async () => {
    await claimRecommendationJob(id, { leaseSeconds: 600, maxAttempts: 2 });
    expect(db.rpc).toHaveBeenCalledWith("claim_recommendation_job", {
      p_job_id: id, p_lease_seconds: 600, p_max_attempts: 2,
    });
  });

  it.each([{ leaseSeconds: 0 }, { leaseSeconds: 3601 }, { maxAttempts: 0 }, { maxAttempts: 1.5 }])(
    "rejects invalid claim limits %j", async (options) => {
      await expect(claimRecommendationJob(id, options)).rejects.toThrow();
      expect(db.rpc).not.toHaveBeenCalled();
    }
  );

  it("returns null when no claim is granted", async () => {
    db.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await claimRecommendationJob(id)).toBeNull();
  });

  it("completes a job with its ownership token and preserves the result", async () => {
    const completed = { ...queuedRow, status: "completed", result, completed_at: now };
    db.maybeSingle.mockResolvedValue({ data: completed, error: null });
    expect(await completeRecommendationJob(id, token, result)).toEqual(completed);
    expect(db.rpc).toHaveBeenCalledWith("finish_recommendation_job", {
      p_job_id: id, p_lock_token: token, p_status: "completed", p_result: result, p_error: null,
    });
  });

  it("validates individual result items before saving", async () => {
    await expect(completeRecommendationJob(id, token, {
      movies: [], series: [{ title: "Dark", year: Number.NaN, recommendation: "Mystery" }],
    })).rejects.toThrow();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("returns null on rejected writes instead of reporting success", async () => {
    db.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await completeRecommendationJob(id, token, result)).toBeNull();
    expect(await failRecommendationJob(id, token, "Please try again.")).toBeNull();
    expect(await retryRecommendationJob(id, token)).toBeNull();
  });

  it("saves safe failure text and releases retries via the guarded RPC", async () => {
    await failRecommendationJob(id, token, " Please try again. ");
    expect(db.rpc).toHaveBeenLastCalledWith("finish_recommendation_job", {
      p_job_id: id, p_lock_token: token, p_status: "failed", p_result: null, p_error: "Please try again.",
    });
    await retryRecommendationJob(id, token);
    expect(db.rpc).toHaveBeenLastCalledWith("finish_recommendation_job", {
      p_job_id: id, p_lock_token: token, p_status: "queued", p_result: null, p_error: null,
    });
  });

  it("does not hide RPC failures as unclaimed jobs", async () => {
    db.maybeSingle.mockResolvedValue({ data: null, error: { message: "RPC unavailable" } });
    await expect(claimRecommendationJob(id)).rejects.toBeInstanceOf(RecommendationJobRepositoryError);
    await expect(completeRecommendationJob(id, token, result)).rejects.toBeInstanceOf(RecommendationJobRepositoryError);
  });

  it("rejects malformed database rows and missing insert responses", async () => {
    db.maybeSingle.mockResolvedValue({ data: { ...queuedRow, status: "completed" }, error: null });
    await expect(getRecommendationJob(id)).rejects.toBeInstanceOf(RecommendationJobRepositoryError);
    db.single.mockResolvedValue({ data: null, error: null });
    await expect(createRecommendationJob("Movies", hash)).rejects.toBeInstanceOf(RecommendationJobRepositoryError);
  });

  it("filters public reads by both ID and token digest and strips the digest from returned rows", async () => {
    db.maybeSingle.mockResolvedValue({ data: { ...queuedRow, access_token_hash: hash }, error: null });
    expect(await getAuthorizedRecommendationJob(id, hash)).toEqual(queuedRow);
    expect(db.eq.mock.calls).toEqual([["id", id], ["access_token_hash", hash]]);
  });

  it("does not fall back to an unprotected read for wrong tokens or missing jobs", async () => {
    db.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getAuthorizedRecommendationJob(id, hash)).toBeNull();
    expect(db.from).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid credentials before querying or inserting", async () => {
    await expect(getAuthorizedRecommendationJob(id, "raw-token")).rejects.toThrow();
    await expect(getAuthorizedRecommendationJob("invalid", hash)).rejects.toThrow();
    await expect(createRecommendationJob("Movies", "raw-token")).rejects.toThrow();
    expect(db.from).not.toHaveBeenCalled();
  });
});
