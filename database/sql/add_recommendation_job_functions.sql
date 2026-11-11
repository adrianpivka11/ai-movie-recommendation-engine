-- Run AFTER create_recommendation_jobs.sql. Does not recreate or delete jobs.
-- Each RPC runs in one database transaction. No AI calls run inside that transaction.
BEGIN;

CREATE OR REPLACE FUNCTION public.claim_recommendation_job(
  p_job_id uuid,
  p_lease_seconds integer DEFAULT 300,
  p_max_attempts integer DEFAULT 3
)
RETURNS SETOF public.recommendation_jobs
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_job public.recommendation_jobs%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_job_id IS NULL OR p_lease_seconds IS NULL
     OR p_lease_seconds NOT BETWEEN 1 AND 3600
     OR p_max_attempts IS NULL OR p_max_attempts NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid job claim arguments' USING ERRCODE = '22023';
  END IF;

  -- Concurrent claimers serialize on this row. The second caller sees the
  -- first caller's committed lease, not the earlier queued state.
  SELECT * INTO v_job FROM public.recommendation_jobs
  WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  v_now := clock_timestamp(); -- Evaluate expiry AFTER waiting for the row lock.

  IF v_job.status IN ('completed', 'failed') THEN RETURN; END IF;
  IF v_job.status = 'processing' AND v_job.locked_until > v_now THEN
    RETURN;
  END IF;

  -- Recover expired attempts, but never spend unlimited AI calls on one job.
  -- An exhausted job becomes terminal on the next claim; no lease is returned.
  IF v_job.attempt_count >= p_max_attempts THEN
    UPDATE public.recommendation_jobs SET
      status = 'failed', result = NULL,
      error = 'Recommendation could not be completed after repeated attempts.',
      lock_token = NULL, locked_until = NULL, completed_at = NULL
    WHERE id = p_job_id;
    RETURN;
  END IF;

  RETURN QUERY UPDATE public.recommendation_jobs SET
    status = 'processing', result = NULL, error = NULL,
    lock_token = gen_random_uuid(),
    locked_until = v_now + make_interval(secs => p_lease_seconds),
    attempt_count = attempt_count + 1,
    started_at = COALESCE(started_at, v_now), completed_at = NULL
  WHERE id = p_job_id RETURNING *;
END;
$$;

-- Complete, fail, or release a processing attempt using the same ownership rules.
CREATE OR REPLACE FUNCTION public.finish_recommendation_job(
  p_job_id uuid,
  p_lock_token uuid,
  p_status text,
  p_result jsonb DEFAULT NULL,
  p_error text DEFAULT NULL
)
RETURNS SETOF public.recommendation_jobs
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_job public.recommendation_jobs%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_job_id IS NULL OR p_lock_token IS NULL OR p_status IS NULL
     OR p_status NOT IN ('completed', 'failed', 'queued') THEN
    RAISE EXCEPTION 'Invalid job finish arguments' USING ERRCODE = '22023';
  END IF;
  IF (p_status = 'completed') <> (p_result IS NOT NULL)
     OR (p_status = 'failed' AND (p_error IS NULL OR length(btrim(p_error)) = 0))
     OR (p_status <> 'failed' AND p_error IS NOT NULL) THEN
    RAISE EXCEPTION 'Invalid result or error for job status' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_job FROM public.recommendation_jobs
  WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  v_now := clock_timestamp();

  -- Reject late workers, including one whose lease expired but has not yet
  -- been reclaimed. Returning zero rows means ownership was not accepted.
  IF v_job.status <> 'processing'
     OR v_job.lock_token IS DISTINCT FROM p_lock_token
     OR v_job.locked_until IS NULL OR v_job.locked_until <= v_now THEN
    RETURN;
  END IF;

  RETURN QUERY UPDATE public.recommendation_jobs SET
    status = p_status, result = p_result, error = p_error,
    lock_token = NULL, locked_until = NULL,
    completed_at = CASE WHEN p_status = 'completed' THEN v_now ELSE NULL END
  WHERE id = p_job_id RETURNING *;
  -- Existing trigger updates updated_at; existing constraints validate result.
END;
$$;

-- Functions normally allow PUBLIC execution. Restrict RPCs to the backend.
-- SECURITY INVOKER also requires the caller's existing table privileges.
REVOKE ALL ON FUNCTION public.claim_recommendation_job(uuid, integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_recommendation_job(uuid, uuid, text, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_recommendation_job(uuid, integer, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_recommendation_job(uuid, uuid, text, jsonb, text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
