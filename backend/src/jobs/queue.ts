import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { z } from "zod";
import { getEnv } from "../env.js";
import type { RecommendationJobMessage } from "./types.js";

// Reuse connections across warm Lambda invocations. Credentials come from its IAM role.
const client = new SQSClient({ maxAttempts: 2 });

/** Build a sender before inserting a job, so missing configuration creates no orphan. */
export function createRecommendationJobSender() {
  const queueUrl = z.url().parse(getEnv("RECOMMENDATION_QUEUE_URL"));
  return async (jobId: string): Promise<void> => {
    const message: RecommendationJobMessage = { jobId: z.string().uuid().parse(jobId) };
    const response = await client.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
    }), { abortSignal: AbortSignal.timeout(10_000) });
    if (!response.MessageId) throw new Error("SQS did not acknowledge the message.");
  };
}
