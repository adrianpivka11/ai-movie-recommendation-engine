import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

/** An opaque 256-bit bearer credential, independent of jobId and the worker lease. */
const accessTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const accessTokenHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Return the raw token once to its creator; persist only its SHA-256 digest. */
export function createJobAccess() {
  const accessToken = randomBytes(32).toString("base64url");
  return { accessToken, accessTokenHash: hashJobAccessToken(accessToken) };
}

/** Fast hashing is appropriate for random high-entropy tokens, not user passwords. */
export function hashJobAccessToken(accessToken: string): string {
  return createHash("sha256").update(accessTokenSchema.parse(accessToken)).digest("hex");
}
