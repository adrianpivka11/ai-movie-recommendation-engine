import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: class { send = mocks.send; },
  SendMessageCommand: class { constructor(public input: unknown) {} },
}));
import { createRecommendationJobSender } from "../jobs/queue.js";

const id = "67d2bb4f-3c69-49b5-9ef7-0f58c70ac179";
const url = "https://sqs.eu-central-1.amazonaws.com/123456789012/recommendations";
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("RECOMMENDATION_QUEUE_URL", url);
  mocks.send.mockResolvedValue({ MessageId: "sqs-id" });
});
afterEach(() => vi.unstubAllEnvs());

describe("job SQS sender", () => {
  it("sends a UUID-only JSON body to the configured queue with a deadline", async () => {
    await createRecommendationJobSender()(id);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ input: {
      QueueUrl: url, MessageBody: JSON.stringify({ jobId: id }),
    } }), { abortSignal: expect.any(AbortSignal) });
  });
  it.each(["", "not-a-url"])("rejects missing/invalid config before creating a sender", (value) => {
    vi.stubEnv("RECOMMENDATION_QUEUE_URL", value);
    expect(createRecommendationJobSender).toThrow();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("rejects invalid IDs without a send", async () => {
    await expect(createRecommendationJobSender()("invalid")).rejects.toThrow();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("propagates send errors for compensation", async () => {
    mocks.send.mockRejectedValue(new Error("Timeout"));
    await expect(createRecommendationJobSender()(id)).rejects.toThrow("Timeout");
  });
  it("requires an acknowledgement", async () => {
    mocks.send.mockResolvedValue({});
    await expect(createRecommendationJobSender()(id)).rejects.toThrow("acknowledge");
  });
});
