import { z } from "zod";
import type { AgentOutput } from "../types.js";
import type { RecommendationJobRow } from "./types.js";

/** Validate actual JSON at the database boundary, not just TypeScript callers. */
export const recommendationResultSchema: z.ZodType<AgentOutput> = z.object({
  movies: z.array(z.object({
    title: z.string(),
    year: z.string(),
    poster_path: z.string(),
    index: z.number().int().nonnegative(),
    isLast: z.boolean(),
    recommendation: z.string(),
  })),
  series: z.array(z.object({
    title: z.string(),
    year: z.number().int().nullable(),
    recommendation: z.string(),
  })),
});

const timestamp = z.string().datetime({ offset: true });
const jobRowBaseSchema = z.object({
  id: z.string().uuid(),
  query: z.string().min(1),
  error: z.string().nullable(),
  attempt_count: z.number().int().nonnegative(),
  lock_token: z.string().uuid().nullable(),
  locked_until: timestamp.nullable(),
  created_at: timestamp,
  updated_at: timestamp,
  started_at: timestamp.nullable(),
  completed_at: timestamp.nullable(),
});

/** Preserve the SQL invariant: a result exists if and only if status is completed. */
export const recommendationJobRowSchema: z.ZodType<RecommendationJobRow> =
  z.discriminatedUnion("status", [
    jobRowBaseSchema.extend({
      status: z.literal("completed"),
      result: recommendationResultSchema,
    }),
    jobRowBaseSchema.extend({
      status: z.enum(["queued", "processing", "failed"]),
      result: z.null(),
    }),
  ]);
