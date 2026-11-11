-- Apply after the table and job RPC migrations, before deploying the handlers.
BEGIN;

-- A separate random bearer token protects each job; lock_token is NOT that token.
-- Store only a SHA-256 digest. A leaked database digest cannot be used as the
-- API credential. The raw token is returned once by the receiving Lambda.
ALTER TABLE public.recommendation_jobs
  ADD COLUMN IF NOT EXISTS access_token_hash text
    CONSTRAINT recommendation_jobs_access_token_hash_format
    CHECK (access_token_hash IS NULL OR access_token_hash ~ '^[a-f0-9]{64}$');

-- NULL intentionally leaves existing jobs inaccessible via the public status API.
-- Do not backfill a shared credential or derive one from the public job ID.
-- New handler inserts always include a hash; internal worker RPCs are unchanged.
-- Existing RLS and service_role-only grants stay in place. The status repository
-- checks both id AND digest because the service_role bypasses row policies.
COMMENT ON COLUMN public.recommendation_jobs.access_token_hash IS
  'SHA-256 of a random per-job bearer token; NULL denies public status access.';

NOTIFY pgrst, 'reload schema';
COMMIT;
