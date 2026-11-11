-- Initial schema for asynchronous recommendation jobs (Lambda + SQS).
-- Run once in the Supabase SQL Editor when setting up a new database.
-- This schema has already been applied to the current Supabase project.
-- Future schema changes should use a separate migration, not rerun this file.

-- Apply the table, trigger, and permissions together or roll back on failure.
BEGIN;

CREATE TABLE public.recommendation_jobs (
  -- Returned to the frontend as jobId; also identifies the job in SQS messages.
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query text NOT NULL CHECK (length(btrim(query)) > 0),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'failed')),

  -- The completed result has the existing AgentOutput shape: { movies, series }.
  -- Before completion, result is SQL NULL (not the JSON value null).
  result jsonb,
  -- Store a user-safe failure message, not credentials or an internal stack trace.
  error text,
  -- The worker will increment this when it successfully claims a processing attempt.
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),

  -- SQS may deliver the same job more than once. Each worker attempt should
  -- atomically claim the job with a fresh random lock_token and an expiry time.
  -- lock_token identifies the attempt, not the user; it is not an API credential.
  -- Before saving a result, the worker must verify it still owns that token.
  -- This prevents an old worker from overwriting a newer attempt's result.
  lock_token uuid,
  -- After this time, a crashed/stalled attempt can be reclaimed by worker logic.
  -- These columns alone do NOT acquire locks, schedule retries, or guarantee
  -- exactly-once execution. Atomic claiming and guarded updates come later.
  locked_until timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,

  -- Reject malformed top-level results: both movies and series must be arrays.
  -- Empty arrays are valid. This does not validate the fields inside each item;
  -- the application must validate those separately.
  -- COALESCE(..., false) rejects missing keys: SQL CHECK would otherwise accept
  -- an unknown (NULL) expression as well as true.
  CONSTRAINT valid_result_shape CHECK (
    result IS NULL OR COALESCE(
      jsonb_typeof(result) = 'object'
      AND jsonb_typeof(result -> 'movies') = 'array'
      AND jsonb_typeof(result -> 'series') = 'array',
      false
    )
  ),
  -- A completed job must have a result; every other status must have SQL NULL.
  -- Update status and result together when finishing a job.
  CONSTRAINT completed_job_has_result CHECK (
    (status = 'completed') = (result IS NOT NULL)
  )
);

-- Supports listing jobs by status and creation time, e.g. finding old queued jobs.
-- The primary key already indexes lookups by jobId.
CREATE INDEX recommendation_jobs_status_created_at_idx
  ON public.recommendation_jobs (status, created_at);

-- Trigger function: NEW is the row about to be stored by an UPDATE.
-- Always set updated_at to the current transaction timestamp so callers do not
-- have to maintain it themselves. RETURN NEW allows the updated row to be saved.
-- An empty search_path avoids resolving objects through user-controlled schemas.
CREATE FUNCTION public.set_recommendation_job_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Attach the function to this table. PostgreSQL invokes it once for each row
-- being updated, before saving the change. INSERT uses the column default.
-- This only maintains updated_at; it does not change status or run the worker.
CREATE TRIGGER recommendation_jobs_updated_at
BEFORE UPDATE ON public.recommendation_jobs
FOR EACH ROW
EXECUTE FUNCTION public.set_recommendation_job_updated_at();

-- Enable row-level security. No client policies are defined, so ordinary roles
-- cannot access rows even if table-level permissions are granted later.
-- Supabase's service_role bypasses RLS; database administrators may bypass it too.
ALTER TABLE public.recommendation_jobs ENABLE ROW LEVEL SECURITY;

-- Remove table-level access for browser-facing roles and the PUBLIC role group.
-- PUBLIC means all database roles, not the public schema.
-- anon is the unauthenticated client role; authenticated is a signed-in user.
-- This is separate from RLS: grants control table operations, RLS controls rows.
REVOKE ALL ON TABLE public.recommendation_jobs
  FROM PUBLIC, anon, authenticated;

-- Allow backend reads, inserts, updates, and deletion of jobs.
-- Supabase secret keys (sb_secret_...) use service_role for Data API access.
-- Keep the key on the backend; the frontend requests job status through our API.
-- The backend API must enforce access to jobs because service_role bypasses RLS.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.recommendation_jobs TO service_role;

COMMIT;
