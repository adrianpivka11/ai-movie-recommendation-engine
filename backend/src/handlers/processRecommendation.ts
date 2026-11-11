import type { Context, SQSEvent, SQSBatchResponse } from "aws-lambda";
import { z } from "zod";
import type { AgentOutput } from "../types.js";
import type { RecommendationJobRow } from "../jobs/types.js";
import type { ClaimRecommendationJobOptions } from "../jobs/repository.js";
import { recommendationResultSchema } from "../jobs/schemas.js";
import { isRetryableRecommendationError } from "../jobs/retryPolicy.js";

export const WORKER_MAX_ATTEMPTS = 3;
export const WORKER_LEASE_SECONDS = 300;
export const WORKER_MAX_RUNTIME_MS = 240_000;
const messageSchema = z.object({ jobId: z.string().uuid() }).strict();
const failureMessage = "Recommendation could not be completed. Please try again.";
const exhaustedMessage = "Recommendation could not be completed after repeated attempts.";

/** Only database methods own state transitions; the worker never writes unguarded rows. */
export type ProcessRecommendationDependencies = {
  claimJob: (id: string, options: ClaimRecommendationJobOptions) => Promise<RecommendationJobRow | null>;
  getJob: (id: string) => Promise<RecommendationJobRow | null>;
  completeJob: (id: string, token: string, result: AgentOutput) => Promise<RecommendationJobRow | null>;
  failJob: (id: string, token: string, message: string) => Promise<RecommendationJobRow | null>;
  retryJob: (id: string, token: string) => Promise<RecommendationJobRow | null>;
  recommend: (query: string) => Promise<AgentOutput>;
};

/**
 * Standard SQS consumer with partial batch failures. No direct message deletion
 * or re-enqueue: Lambda deletes acknowledged records; SQS redelivers failures.
 * Lambda's hard runtime must be shorter than the DB lease, including on crashes.
 */
export function createProcessRecommendationHandler(
  loadDependencies: () => Promise<ProcessRecommendationDependencies>,
) {
  return async (event: SQSEvent, context: Pick<Context, "getRemainingTimeInMillis">): Promise<SQSBatchResponse> => {
    const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];
    if (context.getRemainingTimeInMillis() > WORKER_MAX_RUNTIME_MS) {
      console.error("[Job Worker] Configure Lambda timeout to at most 240 seconds before enabling the trigger.");
      return { batchItemFailures: event.Records.map((record) => ({ itemIdentifier: record.messageId })) };
    }
    let dependencies: ProcessRecommendationDependencies | undefined;
    // Sequential records avoid excess paid parallelism; deploy with batch size 1.
    for (const record of event.Records) {
      try {
        if (context.getRemainingTimeInMillis() < 30_000) throw new Error("Insufficient remaining runtime");
        const { jobId } = messageSchema.parse(JSON.parse(record.body));
        dependencies ??= await loadDependencies();
        if (!await processJob(jobId, dependencies)) {
          batchItemFailures.push({ itemIdentifier: record.messageId });
        }
      } catch (error) {
        // Invalid messages and infrastructure failures go through bounded SQS redrive/DLQ.
        console.error("[Job Worker] Record not acknowledged", { messageId: record.messageId, error });
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}

/** Return true only for confirmed terminal state; busy/lost leases must be redelivered. */
async function processJob(jobId: string, dependencies: ProcessRecommendationDependencies): Promise<boolean> {
  const job = await dependencies.claimJob(jobId, {
    leaseSeconds: WORKER_LEASE_SECONDS, maxAttempts: WORKER_MAX_ATTEMPTS,
  });
  if (!job) {
    const current = await dependencies.getJob(jobId);
    // Includes exhausted attempts marked failed by the claim RPC.
    return current?.status === "completed" || current?.status === "failed";
  }
  if (job.status !== "processing" || !job.lock_token || !job.locked_until
    || job.attempt_count < 1 || job.attempt_count > WORKER_MAX_ATTEMPTS) {
    throw new Error("Claim did not return a valid processing lease");
  }
  const token = job.lock_token;
  let result: AgentOutput;
  try {
    result = recommendationResultSchema.parse(await dependencies.recommend(job.query));
  } catch (error) {
    const retryable = isRetryableRecommendationError(error);
    console.error("[Job Worker] Recommendation failed", { jobId, attempt: job.attempt_count, retryable, error });
    if (retryable && job.attempt_count < WORKER_MAX_ATTEMPTS) {
      await dependencies.retryJob(jobId, token);
      // Even if releasing the lease was rejected, never ACK unfinished work.
      return false;
    }
    const failed = await dependencies.failJob(jobId, token,
      retryable ? exhaustedMessage : failureMessage);
    return failed?.status === "failed";
  }
  // Keep persistence outside the AI catch: a lost commit acknowledgement must
  // not turn a completed job into failed or immediately rerun the paid tools.
  const completed = await dependencies.completeJob(jobId, token, result);
  return completed?.status === "completed";
}

/** Production entrypoint; reuse the existing local RAG/web-search router, without MCP. */
export const handler = createProcessRecommendationHandler(async () => {
  const repository = await import("../jobs/repository.js");
  return {
    claimJob: repository.claimRecommendationJob,
    getJob: repository.getRecommendationJob,
    completeJob: repository.completeRecommendationJob,
    failJob: repository.failRecommendationJob,
    retryJob: repository.retryRecommendationJob,
    recommend: async (query) => {
      const { movieChoiceAgentLatestVersion } = await import("../agentLatestVersion.js");
      return movieChoiceAgentLatestVersion(query);
    },
  };
});
