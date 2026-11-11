import { describe, expect, it } from "vitest";
import { createJobAccess, hashJobAccessToken } from "../jobs/access.js";

describe("per-job access credentials", () => {
  it("creates independent random credentials and stores only their digests", () => {
    const a = createJobAccess();
    const b = createJobAccess();
    expect(a.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.accessTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(a.accessTokenHash).toBe(hashJobAccessToken(a.accessToken));
    expect(a.accessToken).not.toBe(b.accessToken);
    expect(a.accessTokenHash).not.toBe(b.accessTokenHash);
  });
  it.each(["", "invalid", "a".repeat(64), "!".repeat(43)])("rejects malformed tokens (%#)", (token) => {
    expect(() => hashJobAccessToken(token)).toThrow();
  });
});
