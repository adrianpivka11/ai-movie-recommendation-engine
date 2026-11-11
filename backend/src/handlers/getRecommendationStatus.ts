import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { z } from "zod";
import { hashJobAccessToken } from "../jobs/access.js";
import { recommendationResultSchema } from "../jobs/schemas.js";
import type { GetRecommendationJobResponse, RecommendationJobRow } from "../jobs/types.js";

/** Only an authorization-filtered repository read is available to this handler. */
export type GetRecommendationStatusDependencies = {
  getAuthorizedJob: (jobId: string, accessTokenHash: string) => Promise<RecommendationJobRow | null>;
};

/** Do not cache private status/results, including errors and not-found responses. */
function response(statusCode: number, body: GetRecommendationJobResponse): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(statusCode === 401 ? { "www-authenticate": "Bearer" } : {}),
    },
    body: JSON.stringify(body),
  };
}

/**
 * GET /api/jobs/{jobId} for API Gateway HTTP API payload v2.
 * Possession of a separate per-job token authorizes this read; jobId alone does
 * not. The token is never accepted in query parameters or copied into logs.
 */
export function createGetRecommendationStatusHandler(
  loadDependencies: () => Promise<GetRecommendationStatusDependencies>,
) {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    if (event.requestContext.http.method !== "GET") return response(405, { error: "Method not allowed." });
    const parsedId = z.string().uuid().safeParse(event.pathParameters?.jobId);
    if (!parsedId.success) return response(400, { error: "Invalid job ID." });
    const jobId = parsedId.data;

    let accessTokenHash: string;
    try {
      const headers = Object.entries(event.headers ?? {}).filter(([key]) => key.toLowerCase() === "authorization");
      if (headers.length !== 1) throw new Error("Missing or ambiguous authorization");
      const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(headers[0][1] ?? "");
      if (!bearer) throw new Error("Invalid bearer credential");
      accessTokenHash = hashJobAccessToken(bearer[1]);
    } catch {
      return response(401, { error: "A valid job access token is required." });
    }

    let job: RecommendationJobRow | null;
    try {
      const dependencies = await loadDependencies();
      job = await dependencies.getAuthorizedJob(jobId, accessTokenHash);
    } catch {
      // Do not log the event, token, query, or provider error that may contain them.
      console.error("[Job Status] Authorized read unavailable", { jobId });
      return response(503, { error: "Job status is temporarily unavailable. Please try again." });
    }
    if (!job) return response(404, { error: "Job not found." });

    try {
      // Explicit allowlist: never spread a database row into a public response.
      switch (job.status) {
        case "queued":
        case "processing":
          return response(200, { jobId, status: job.status });
        case "completed":
          return response(200, { jobId, status: "completed", result: recommendationResultSchema.parse(job.result) });
        case "failed":
          return response(200, { jobId, status: "failed", error: "Recommendation could not be completed. Please try again." });
        default:
          throw new Error("Invalid job status");
      }
    } catch {
      console.error("[Job Status] Invalid stored result", { jobId });
      return response(500, { error: "Job status is temporarily unavailable. Please try again." });
    }
  };
}

/** Load the server-only Supabase client only after request validation. */
export const handler = createGetRecommendationStatusHandler(async () => {
  const { getAuthorizedRecommendationJob } = await import("../jobs/repository.js");
  return { getAuthorizedJob: getAuthorizedRecommendationJob };
});
