# Database Pipeline

This folder contains the Python scripts and data artifacts used to build and enrich the Supabase movie database.

## Setup

Create and activate the virtual environment:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

## Contents

- `scripts` - Python scripts for TMDB retrieval, CSV cleaning, batching, and embedding updates.
- `data` - CSV and JSON data files generated during database preparation.
- `sql/create_recommendation_jobs.sql` - documented initial schema for asynchronous recommendation jobs, including result checks, worker lease fields, timestamps, and backend-only access. Already applied to the current Supabase project; run once only when setting up a new database.
- `sql/add_recommendation_job_functions.sql` - next migration: run in the Supabase SQL Editor after the initial job schema. Adds backend-only RPCs for atomic claiming and guarded completion/failure/retry; it preserves existing jobs and can be reapplied.
- `sql/add_recommendation_job_access.sql` - run after the job RPC migration and before deploying the new submit/status handlers. Adds the per-job token digest; existing rows remain intact but cannot be read through the public status API without a token. Can be reapplied.
- `sql/tests/recommendation_job_access.test.sql` - verifies digest filtering, rejection of malformed digests, legacy denial, and compatibility of the existing worker RPCs. Run in a test database after all three migrations; fixtures are rolled back.
- `sql/tests/recommendation_jobs.test.sql` - SQL assertions for lease ownership, expiry, retries, terminal states, and RPC permissions. Run against a test database after both schema files; fixtures are rolled back.
- `scripts/test_job_claim_concurrency.mjs` - two real PostgreSQL connections racing for one job. Run with `node database/scripts/test_job_claim_concurrency.mjs` from the repository root. Uses an isolated local PostgreSQL test instance at `127.0.0.1:55483` (override port via `JOB_TEST_PGPORT`), `postgres` user/database, and `psql` on PATH. Requires both schema files and Supabase-compatible test roles; deletes only its own fixture.
- `.env` - local secrets for TMDB, Supabase, and OpenAI. Do not commit this file.
