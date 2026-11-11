import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { z } from "zod";
import type { RecommendationJobRow, CreateRecommendationJobResponse } from "../jobs/types.js";
import { createJobAccess } from "../jobs/access.js";

const requestSchema = z.object({
  movieOrSerieUserRequest: z.string().trim().min(1).max(10_000),
});
const unavailable = "Recommendation service is temporarily unavailable. Please try again.";
const enqueueFailure = "Recommendation could not be queued. Please submit a new request.";

/** Dependencies are injectable so tests never contact Supabase, SQS, or an AI model. */
export type SubmitRecommendationDependencies = {
  createJob: (query: string, accessTokenHash: string) => Promise<RecommendationJobRow>;
  sendJob: (jobId: string) => Promise<void>;
  failUnsubmittedJob: (jobId: string, message: string) => Promise<RecommendationJobRow | null>;
};

/** Explicit JSON responses keep internal rows and provider errors out of the API. */
function response(statusCode: number, body: CreateRecommendationJobResponse): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) };
}

/**
 * API Gateway HTTP API (payload v2) receiver. Return 202 only after confirmed send.
 * Compensation is best effort, not a distributed transaction: a crash or a second
 * database outage can leave queued work requiring reconciliation (see API docs).
 */
export function createSubmitRecommendationHandler(
  loadDependencies: () => Promise<SubmitRecommendationDependencies>,
) {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    if (event.requestContext.http.method !== "POST") {
      return response(405, { error: "Method not allowed." });
    }
    let query: string;
    try {
      const body = event.isBase64Encoded
        ? Buffer.from(event.body ?? "", "base64").toString("utf8")
        : event.body ?? "";
      if (Buffer.byteLength(body, "utf8") > 100_000) throw new Error("Body too large");
      query = requestSchema.parse(JSON.parse(body)).movieOrSerieUserRequest;
    } catch {
      return response(400, { error: "Provide a movie or series request between 1 and 10000 characters." });
    }

    let dependencies: SubmitRecommendationDependencies;
    let job: RecommendationJobRow;
    let accessToken: string;
    try {
      dependencies = await loadDependencies();
      const access = createJobAccess();
      accessToken = access.accessToken;
      job = await dependencies.createJob(query, access.accessTokenHash);
    } catch (error) {
      console.error("[Submit Job] Could not create job", error);
      return response(503, { error: unavailable });
    }

    try {
      await dependencies.sendJob(job.id);
    } catch (error) {
      console.error("[Submit Job] SQS send failed or acknowledgement was lost", { jobId: job.id, error });
      try {
        const cancelled = await dependencies.failUnsubmittedJob(job.id, enqueueFailure);
        if (!cancelled) {
          console.warn("[Submit Job] Compensation skipped; job may already be processing", { jobId: job.id });
        }
      } catch (compensationError) {
        // Preserve the ID for operations/reconciliation; do not claim the rollback succeeded.
        console.error("[Submit Job] RECONCILIATION_REQUIRED", { jobId: job.id, error: compensationError });
      }
      return response(503, { error: unavailable });
    }
    return response(202, { jobId: job.id, accessToken });
  };
}

/** Lambda entrypoint; lazy imports allow input validation without provider configuration. */
export const handler = createSubmitRecommendationHandler(async () => {
  const queue = await import("../jobs/queue.js");
  const sendJob = queue.createRecommendationJobSender();
  const repository = await import("../jobs/repository.js");
  return {
    createJob: repository.createRecommendationJob,
    sendJob,
    failUnsubmittedJob: repository.failUnsubmittedRecommendationJob,
  };
});
