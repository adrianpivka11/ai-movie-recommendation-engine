# Asynchronous recommendation API contract

Status: receiving, worker and status Lambdas implemented, not deployed. The current Express POST endpoint still returns HTTP 200
with `{ "agenticStructuredData": { "movies": [], "series": [] } }`.
The asynchronous endpoints below will be enabled when AWS routes and frontend
polling are connected. They are not exposed by the current Express app.

Types: [backend/src/jobs/types.ts](../backend/src/jobs/types.ts).
Database schema: [recommendation_jobs](../database/sql/create_recommendation_jobs.sql).
The recommendation result reuses the existing backend `AgentOutput` type.

## Submit a job

`POST /api/recommend`, with `Content-Type: application/json`.

Request (`CreateRecommendationJobRequest`):

```json
{ "movieOrSerieUserRequest": "Recommend romantic movies" }
```

The handler validates a non-empty string (maximum 10000 characters after trimming),
trims it, and stores it as `query`. JSON bodies are limited to 100000 UTF-8 bytes.
It creates the database row, sends its ID to SQS, and only then returns HTTP 202
(`CreateRecommendationJobAcceptedResponse`):

```json
{
  "jobId": "67d2bb4f-3c69-49b5-9ef7-0f58c70ac179",
  "accessToken": "<random 43-character per-job token>"
}
```

202 means accepted for asynchronous processing, not successfully completed.
The access token is returned once; the database stores only its SHA-256 digest.
This extends the original jobId-only response to authorize private status reads.
The Supabase insert and SQS send are not one transaction; see the receiving
handler's compensation policy below.

Each new POST creates a new job. Deduplicating SQS deliveries for the same jobId
does not deduplicate separate POST requests from a user.

## SQS message body

`RecommendationJobMessage` is serialized as JSON into the SQS message body:

```json
{ "jobId": "67d2bb4f-3c69-49b5-9ef7-0f58c70ac179" }
```

This is not the AWS event envelope. The worker parses each record's body and
validates jobId as a UUID. It loads the query, status, and lease from Supabase.
The SQS messageId is transport metadata; jobId identifies the application job
across redeliveries.

## Read job status

`GET /api/jobs/:jobId`, where jobId is a valid UUID, with the header:

```http
Authorization: Bearer <accessToken from POST>
```

An existing accessible job returns HTTP 200 (`RecommendationJobStatusResponse`).

Queued or processing (no result or error fields):

```json
{ "jobId": "67d2bb4f-3c69-49b5-9ef7-0f58c70ac179", "status": "queued" }
```

Completed (result is required; these empty arrays are a valid example):

```json
{
  "jobId": "67d2bb4f-3c69-49b5-9ef7-0f58c70ac179",
  "status": "completed",
  "result": { "movies": [], "series": [] }
}
```

The result has no `agenticStructuredData` wrapper. Movie and series items keep
their existing `AgentOutput` fields, including the different year types:
movie years are strings; series years are numbers or null.

Failed (a safe display message is required; no result field):

```json
{
  "jobId": "67d2bb4f-3c69-49b5-9ef7-0f58c70ac179",
  "status": "failed",
  "error": "Recommendation could not be completed. Please try again."
}
```

The frontend polls while status is queued or processing and stops on completed
or failed. Reading a failed job is still HTTP 200: the GET succeeded even though
the background work failed.

## API errors

Non-2xx responses use `RecommendationJobApiErrorResponse`: `{ "error": "..." }`.
They have no job status or result. HTTP status codes are part of the endpoint
contract, not fields inside the JSON response.

| HTTP status | Meaning |
| --- | --- |
| 400 | Invalid JSON/body for POST, or an invalid jobId for GET. |
| 401 | Missing/malformed bearer credential on GET; no database read. |
| 404 | No accessible job exists for the requested jobId. |
| 405 | Wrong HTTP method for the receiving/status Lambda. |
| 503 | Temporary database/queue failure prevents accepting a job or reading its status. |
| 500 | Unexpected internal failure; return a generic safe message. |

## Database and processing boundaries

`RecommendationJobRow` uses the existing snake_case SQL columns. Its id is
exposed as jobId. SQL NULL is represented by JavaScript null; timestamps are
ISO strings. Only completed rows have a non-null result. Database error is
nullable; the status handler always uses fixed safe text, never the stored error.

The normal lifecycle is queued -> processing -> completed or failed. Retryable
failures may return to queued; terminal failed jobs must not be processed again.
The worker increments attempt_count when it atomically claims an attempt, sets
a fresh lock_token and locked_until, and guards subsequent updates with that
ownership token. started_at records the first processing start; completed_at
records successful completion. These operations are not implemented by types.

The status handler must explicitly construct the public response, not spread
a database row into JSON. Do not expose query, attempts, leases, or raw errors.
TypeScript types do not validate network input or filter runtime object fields.
The repository now validates database rows/results and provides atomic claiming
with attempt limits (see below). HTTP input validation and SQS send failure handling
are implemented, as are worker input validation and per-job token authorization.
Knowing a jobId alone does not authorize a read.

The database remains backend-only. No direct frontend Supabase access or AWS
SDK dependency is introduced by this contract.

## Database repository (implemented)

`backend/src/jobs/repository.ts` uses the existing backend Supabase client:

| Function | Behavior |
| --- | --- |
| `createRecommendationJob(query, accessTokenHash)` | Trim/validate input and insert a queued row with its credential digest. |
| `getRecommendationJob(jobId)` | Trusted worker/internal read only; not suitable for public endpoints. |
| `getAuthorizedRecommendationJob(jobId, accessTokenHash)` | Public status read filtered by BOTH ID and token digest; null for nonexistent, unauthorized or legacy jobs. |
| `claimRecommendationJob(jobId, options?)` | Atomically claim queued/expired work; default lease 300 seconds, maximum 3 attempts. |
| `completeRecommendationJob(jobId, lockToken, result)` | Validate and store the result only for the current, unexpired lease. |
| `failRecommendationJob(jobId, lockToken, publicError)` | Store a safe terminal failure under the same ownership check. |
| `retryRecommendationJob(jobId, lockToken)` | Release an owned lease to queued, preserving attempt_count. Does not send to SQS. |
| `failUnsubmittedRecommendationJob(jobId, publicError)` | Fail only a queued job with attempt_count = 0 after an unsuccessful/uncertain send. |

Apply `database/sql/add_recommendation_job_functions.sql` in the Supabase SQL
Editor. It adds `claim_recommendation_job` and `finish_recommendation_job` RPCs
and restricts their execution to service_role. Do not rerun the initial table
creation script. No new environment variables are required.

The RPCs use SELECT FOR UPDATE inside a short transaction; lease expiry is
evaluated using the database clock after the row lock is acquired. A claim
returns no row for missing, busy, or terminal jobs. An eligible job already at
the attempt limit is marked failed and no new lease is granted. Read the job to
distinguish these cases; a busy job is not automatically safe to ACK in SQS.

Finishing returns null if ownership is rejected, rather than silently reporting
success. Database errors throw RecommendationJobRepositoryError with an internal
cause. The handlers must not serialize that cause to the frontend.

SQL locks are released when the RPC transaction ends; lock_token/locked_until
represent the longer processing lease. Expiry does not stop an already running
AI request, so these guards prevent stale database writes, not all duplicate
external work. Worker timeout, SQS visibility timeout, retry/redelivery behavior,
and DLQ handling must be coordinated in the later worker/infrastructure steps.

## Receiving Lambda (implemented, not deployed)

Source: `backend/src/handlers/submitRecommendation.ts`; compiled Lambda handler:
`dist/handlers/submitRecommendation.handler` (relative to a package containing dist).
Use API Gateway HTTP API payload format 2.0 and the POST /api/recommend route.
It validates JSON, including base64-encoded bodies, creates a row, sends
`{ jobId }` using AWS SDK v3, and returns 202 only on an acknowledged SQS send.
No AI calls take place in this handler. The existing Express app is unchanged.

Later infrastructure must supply:
- `SUPABASE_URL` and backend-only `SUPABASE_API_KEY` with service_role access.
- `RECOMMENDATION_QUEUE_URL`, the URL of a **Standard** SQS queue (not FIFO).
- AWS region (Lambda supplies `AWS_REGION`) and an execution role granting
  `sqs:SendMessage` for that queue. Do not put long-lived AWS keys in source files.
- API Gateway CORS restricted to the frontend origin; auth/rate limiting before
  public exposure, plus CloudWatch logging/alerts for the failures below.

The SDK uses at most two attempts with a 10-second total send deadline. The
Lambda timeout must leave additional time for Supabase insertion and compensation.
Timeout values will be aligned with infrastructure configuration later.
SDK usage follows the [AWS SQS examples](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_sqs_code_examples.html).

### Failure and uncertainty policy

- Database/configuration failure: 503, no SQS send.
- SQS rejection or timeout: 503 with safe text, then a guarded compensation
  UPDATE marks the row failed only if still queued and never claimed. The
  handler waits for this compensation attempt before returning the response.
- A timeout does not prove SQS rejected the message. If compensation wins the
  race, the worker skips that terminal failed job. If the worker
  claimed first, compensation cannot overwrite its work, even after a retry.
  The API still returns 503 because it did not receive an acknowledgement;
  processing may nevertheless finish. A new POST is a new job and can repeat work.
- If compensation also fails, log `RECONCILIATION_REQUIRED` with jobId. Do not
  pretend the job was cancelled. Operations must inspect that row and the queue.
- A process crash after insert but before send (or loss of the insert response)
  can also leave an orphan. This implementation is best-effort compensation,
  not guaranteed delivery or exactly-once execution. A transactional outbox or
  scheduled reconciliation is a separate follow-up needed for stronger guarantees.

No further SQL migration is needed for this step: compensation uses one atomic
conditional UPDATE and the table's existing service_role UPDATE permission.
The worker and status handlers are described below. Frontend polling, AWS resources
and deployment are not implemented yet. Automated receiver/queue tests mock providers and incur no
Supabase, SQS, or OpenAI usage.

## Worker Lambda (implemented, not deployed)

Source: `backend/src/handlers/processRecommendation.ts`; compiled entrypoint:
`dist/handlers/processRecommendation.handler`. Consumes Standard SQS events, not
HTTP. It validates each `{ jobId }`, atomically claims the row, and calls the
existing `movieChoiceAgentLatestVersion` with the stored query. No MCP is used.
For mixed queries the router now waits for both tools to settle before throwing,
so releasing a lease cannot overlap a still-running sibling tool.

### State transitions and failures

- Only the claimed token can complete, fail, or release an attempt. Result JSON
  is validated before completion. A rejected write never counts as success.
- Completed/failed jobs are acknowledged without AI calls, including exhausted
  jobs marked failed by the claim RPC.
- Busy jobs owned by another worker are NOT processed and NOT acknowledged.
  Their messages are returned in batchItemFailures for later redelivery.
- Transient errors (HTTP 408/429/5xx, selected network/Postgres errors) release
  the lease to queued and retain the message. No immediate AI retry or new
  SendMessage call occurs; SQS redelivery schedules the next attempt.
- Maximum **3 claimed attempts per job**, including crashed/timed-out attempts.
  The third transient failure becomes terminal. After a third crash, the next
  claim marks the job failed without running AI.
- Authentication/input/model errors, insufficient quota (even with HTTP 429),
  malformed output and unknown errors are terminal immediately. Classification
  uses structured metadata, not guesses from message text.
- A failed/uncertain completion write retains the message without replacing the
  result with an error or releasing its lease. If the commit succeeded, redelivery
  sees the completed row. If not, recovery after expiry can repeat paid work.
- Invalid messages, missing jobs and infrastructure failures are retained for
  bounded SQS redrive/DLQ handling. AI is never called without a claim.
- Partial batch failures contain SQS messageId, not the application jobId.

Three attempts are NOT three provider requests: each router run can invoke several
model calls, and the existing AI SDK has its own bounded retries. Exactly-once
billing is not guaranteed after a timeout/lost result. New POSTs create new jobs
with separate limits.

### Required deployment settings (not provisioned yet)

- Lambda timeout **240 seconds or less**; DB lease **300 seconds**. Invocations
  reporting more than 240 seconds remaining are rejected before claiming. No new
  record starts with less than 30 seconds remaining. Do not increase runtime
  without redesigning leases. Lambda's hard timeout ends local execution before
  reclaim; an external provider may still finish and charge for a request.
- Use **batch size 1**, batching window 0, **ReportBatchItemFailures** enabled.
  Larger batches are supported sequentially, but a Lambda timeout retries the
  batch; completed rows still prevent repeated recommendations.
- For a 240-second Lambda, SQS visibility timeout should be at least **1440
  seconds (24 minutes)**. Retries can take that long to reappear. This is distinct
  from the five-minute DB lease. See [AWS SQS configuration](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html)
  and [partial failures](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html).
- Configure a DLQ with finite maxReceiveCount (start with 5), retention longer
  than the source queue, and alarms. SQS receive counts differ from DB attempts:
  busy/malformed messages can reach DLQ without AI calls. A DLQ recovery process
  remains necessary: moving a message there does not update its database row.
- Start with low worker concurrency (for example reserved concurrency 2).
  Per-job attempt limits are not a global spending cap.
- Provide existing Supabase secrets and the RAG/web-search model variables from
  the working backend. No MCP configuration or new SQL is needed. Grant the worker
  SQS receive/delete/get-attributes and CloudWatch permissions. It does not need
  sqs:SendMessage or RECOMMENDATION_QUEUE_URL.

Tests cover processing, redelivery, concurrent claims (mocked at the worker
boundary; SQL atomicity tested separately), retry limits, permanent errors, lost
leases, persistence failures, partial batches and runtime guards. They do not
contact paid providers or deploy AWS resources.

## Status Lambda and access protection (implemented, not deployed)

Source: `backend/src/handlers/getRecommendationStatus.ts`; compiled entrypoint:
`dist/handlers/getRecommendationStatus.handler`. Map API Gateway HTTP API payload
v2 GET /api/jobs/{jobId} to it. It needs only the existing Supabase backend secret
and URL, not model credentials, SQS access, or MCP configuration.

Apply `database/sql/add_recommendation_job_access.sql` before deploying the updated
submit/status handlers. It adds nullable access_token_hash without deleting rows
or changing worker RPCs. Existing jobs have no token and deliberately remain
inaccessible through the public status API; submit a new job instead of sharing
or deriving a credential from jobId. No new environment variables are needed.

The agreed anonymous-access model is a per-job bearer capability:
- POST generates 32 cryptographically random bytes using Node crypto, encodes
  them as base64url, stores SHA-256 in the same insert as the job, and returns the
  raw token only in a successful 202 response. The token never goes to SQS.
- GET accepts only Authorization: Bearer, not URL/query parameters. The backend
  hashes it and queries with both id and access_token_hash. RLS is not relied on
  for this check because the backend service_role bypasses it.
- Wrong well-formed tokens and missing jobs both return the same 404. No fallback
  to an unprotected ID-only read exists. A token for job A cannot read job B.
- Responses explicitly allowlist public fields. Internal query, lock_token,
  locked_until, attempt counters, timestamps, token digest and raw database error
  are never returned. Result validation also strips unknown nested fields.
- This is possession-based access, not proof of a person's identity. Anyone who
  steals or receives the token can read that job. Tokens have no automatic expiry
  in this version; deleting the row or clearing its digest revokes access. Losing
  a token means losing access; there is no anonymous recovery endpoint.
- Future frontend polling must retain jobId/token together in memory (or
  sessionStorage if reload persistence is required). Do not print them to the
  console or place tokens in URLs, analytics, or client error reports. Browser
  XSS can steal stored credentials; token protection is not an XSS mitigation.
- Require HTTPS, disable API/CDN caching for private routes (handlers send
  Cache-Control: no-store), and redact Authorization headers/POST response bodies
  from infrastructure logs. Permit Authorization in the API Gateway CORS headers
  for the specific frontend origin. CORS alone is not access control.
- Public POST still needs throttling/abuse controls before exposure: status tokens
  protect results but do not prevent strangers from initiating paid AI jobs.

Tests exercise all statuses, malformed UUIDs/headers, missing and wrong credentials,
cross-job access, safe failure messages, internal-field stripping, database errors,
and submit-to-status credential flow. SQL tests check digest constraints/filtering
and confirm existing worker claim/completion RPCs still work after the migration.
