import { z } from "zod";
import { supabase } from "../supabaseClient.js";
import type { AgentOutput } from "../types.js";
import type { RecommendationJobRow } from "./types.js";
import { recommendationJobRowSchema, recommendationResultSchema } from "./schemas.js";
import { accessTokenHashSchema } from "./access.js";

const uuid = z.string().uuid();
const claimOptionsSchema = z.object({
  leaseSeconds: z.number().int().min(1).max(3600).default(300),
  maxAttempts: z.number().int().min(1).max(100).default(3),
});

/** Processing limits; later worker configuration must align with its timeout/SQS. */
export type ClaimRecommendationJobOptions = {
  leaseSeconds?: number;
  maxAttempts?: number;
};

/** Internal failure with the original cause for server logs, never a public body. */
export class RecommendationJobRepositoryError extends Error {
  constructor(operation: string, cause: unknown) {
    super(`Could not ${operation} recommendation job.`, { cause });
    this.name = "RecommendationJobRepositoryError";
  }
}

/** Create a queued job. Database defaults generate its UUID and timestamps. */
export async function createRecommendationJob(query: string, accessTokenHash: string): Promise<RecommendationJobRow> {
  const trimmedQuery = z.string().trim().min(1).parse(query);
  const hash = accessTokenHashSchema.parse(accessTokenHash);
  const { data, error } = await supabase.from("recommendation_jobs")
    .insert({ query: trimmedQuery, access_token_hash: hash }).select("*").single();
  const job = readRow(data, error, "create");
  if (!job) throw new RecommendationJobRepositoryError("create", new Error("Missing inserted row"));
  return job;
}

/** Return null only for a missing job; connection/query errors are thrown. */
export async function getRecommendationJob(jobId: string): Promise<RecommendationJobRow | null> {
  uuid.parse(jobId);
  const { data, error } = await supabase.from("recommendation_jobs")
    .select("*").eq("id", jobId).maybeSingle();
  return readRow(data, error, "read");
}

/**
 * Public API reads must match BOTH id and credential digest, because service_role
 * bypasses RLS. Missing rows, wrong tokens and legacy rows without a hash all
 * return null. Keep getRecommendationJob for trusted worker/internal use only.
 */
export async function getAuthorizedRecommendationJob(
  jobId: string, accessTokenHash: string,
): Promise<RecommendationJobRow | null> {
  uuid.parse(jobId);
  const hash = accessTokenHashSchema.parse(accessTokenHash);
  const { data, error } = await supabase.from("recommendation_jobs")
    .select("*").eq("id", jobId).eq("access_token_hash", hash).maybeSingle();
  return readRow(data, error, "read authorized");
}

/**
 * Compensate an unsuccessful/uncertain SQS send without overwriting a worker.
 * One conditional UPDATE competes atomically with claim's row lock. A worker
 * that already claimed the job wins; even a requeued attempted job is untouched.
 */
export async function failUnsubmittedRecommendationJob(
  jobId: string, publicError: string,
): Promise<RecommendationJobRow | null> {
  uuid.parse(jobId);
  const errorMessage = z.string().trim().min(1).parse(publicError);
  const { data, error } = await supabase.from("recommendation_jobs")
    .update({ status: "failed", error: errorMessage })
    .eq("id", jobId).eq("status", "queued").eq("attempt_count", 0)
    .select("*").maybeSingle();
  return readRow(data, error, "cancel unsubmitted");
}

/**
 * Atomically acquire a lease and increment attempts using a PostgreSQL RPC.
 * null means missing, busy, terminal, or attempts exhausted; read the job to
 * distinguish these cases. A busy job must not automatically ACK an SQS message.
 */
export async function claimRecommendationJob(
  jobId: string,
  options: ClaimRecommendationJobOptions = {},
): Promise<RecommendationJobRow | null> {
  uuid.parse(jobId);
  const { leaseSeconds, maxAttempts } = claimOptionsSchema.parse(options);
  const { data, error } = await supabase.rpc("claim_recommendation_job", {
    p_job_id: jobId,
    p_lease_seconds: leaseSeconds,
    p_max_attempts: maxAttempts,
  }).maybeSingle();
  return readRow(data, error, "claim");
}

/** Save a validated result only while this worker still holds a live lease. */
export async function completeRecommendationJob(
  jobId: string, lockToken: string, result: AgentOutput,
): Promise<RecommendationJobRow | null> {
  return finishJob(jobId, lockToken, "completed", recommendationResultSchema.parse(result), null);
}

/** Record a terminal failure. The caller must supply a user-safe message. */
export async function failRecommendationJob(
  jobId: string, lockToken: string, publicError: string,
): Promise<RecommendationJobRow | null> {
  return finishJob(jobId, lockToken, "failed", null, z.string().trim().min(1).parse(publicError));
}

/**
 * Release a live lease back to queued without resetting attempts.
 * This does not send an SQS message; the worker must arrange redelivery.
 */
export async function retryRecommendationJob(
  jobId: string, lockToken: string,
): Promise<RecommendationJobRow | null> {
  return finishJob(jobId, lockToken, "queued", null, null);
}

/** Null means the write was rejected (missing job, wrong/expired lease, or terminal state). */
async function finishJob(
  jobId: string,
  lockToken: string,
  status: "completed" | "failed" | "queued",
  result: AgentOutput | null,
  errorMessage: string | null,
): Promise<RecommendationJobRow | null> {
  uuid.parse(jobId);
  uuid.parse(lockToken);
  const { data, error } = await supabase.rpc("finish_recommendation_job", {
    p_job_id: jobId,
    p_lock_token: lockToken,
    p_status: status,
    p_result: result,
    p_error: errorMessage,
  }).maybeSingle();
  return readRow(data, error, "finish");
}

/** Validate returned rows and retain database failures separately from absent rows. */
function readRow(data: unknown, error: unknown, operation: string): RecommendationJobRow | null {
  if (error) throw new RecommendationJobRepositoryError(operation, error);
  if (data === null) return null;
  const parsed = recommendationJobRowSchema.safeParse(data);
  if (!parsed.success) throw new RecommendationJobRepositoryError(operation, parsed.error);
  return parsed.data;
}
