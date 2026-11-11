import type { AgentOutput } from "../types.js";

/** Job lifecycle values stored in public.recommendation_jobs. */
export type RecommendationJobStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed";

/**
 * Internal database fields, using the SQL column names.
 * UUIDs and timestamptz values arrive from Supabase as strings, not Date objects.
 * This record must not be returned directly by the public API.
 */
type RecommendationJobRowBase = {
  id: string;
  query: string;
  /** User-safe failure message; never a raw provider error or stack trace. */
  error: string | null;
  attempt_count: number;
  /** Identifies the worker attempt that currently owns the processing lease. */
  lock_token: string | null;
  /** ISO timestamp after which worker logic can reclaim an unfinished job. */
  locked_until: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
};

/**
 * Internal job record matching the SQL completed_job_has_result constraint.
 * Only completed rows have a result; other rows contain SQL NULL.
 * Runtime validation is still required when reading external JSON.
 */
export type RecommendationJobRow = RecommendationJobRowBase &
  (
    | { status: "completed"; result: AgentOutput }
    | {
        status: Exclude<RecommendationJobStatus, "completed">;
        result: null;
      }
  );

/**
 * JSON body sent to SQS (not the surrounding AWS SQS event/record).
 * jobId is the database UUID, not the SQS messageId. The worker loads the query
 * and current state from Supabase instead of trusting a copy in the message.
 * Receivers must parse JSON and validate the UUID before processing it.
 */
export type RecommendationJobMessage = {
  jobId: string;
};

/**
 * POST /api/recommend JSON body. Preserve the existing form field name.
 * The receiving handler must validate and trim this non-empty string.
 */
export type CreateRecommendationJobRequest = {
  movieOrSerieUserRequest: string;
};

/** HTTP 202 body, returned after the job is stored and its SQS send succeeds. */
export type CreateRecommendationJobAcceptedResponse = {
  jobId: string;
  /** Per-job bearer credential returned once; never place it in URLs or logs. */
  accessToken: string;
  error?: never;
};

/**
 * HTTP 200 body for GET /api/jobs/:jobId.
 * The status discriminant determines which payload the frontend can read.
 * Failed jobs are valid status responses, not failures of the GET request.
 * No query, lease information, attempt counts, or internal errors are exposed.
 */
export type RecommendationJobStatusResponse = { jobId: string } &
  (
    | {
        status: "queued" | "processing";
        result?: never;
        error?: never;
      }
    | {
        status: "completed";
        result: AgentOutput;
        error?: never;
      }
    | {
        status: "failed";
        result?: never;
        /** Fixed public message; never return the raw database error. */
        error: string;
      }
  );

/** Non-2xx API response body; separate from a job whose status is failed. */
export type RecommendationJobApiErrorResponse = {
  error: string;
  jobId?: never;
  status?: never;
  result?: never;
};

/** All response bodies for the future asynchronous POST endpoint. */
export type CreateRecommendationJobResponse =
  | CreateRecommendationJobAcceptedResponse
  | RecommendationJobApiErrorResponse;

/** All response bodies for the future job status endpoint. */
export type GetRecommendationJobResponse =
  | RecommendationJobStatusResponse
  | RecommendationJobApiErrorResponse;
