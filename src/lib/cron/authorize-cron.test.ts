import { describe, expect, it } from "vitest";

import { isCronRequestAuthorized } from "./authorize-cron";

describe("isCronRequestAuthorized", () => {
  it("accepts the bearer secret Vercel Cron sends", () => {
    expect(isCronRequestAuthorized("Bearer keep-alive-secret", "keep-alive-secret")).toBe(
      true,
    );
  });

  it("rejects a missing secret, a missing header, and a mismatched bearer", () => {
    expect(isCronRequestAuthorized("Bearer keep-alive-secret", undefined)).toBe(false);
    expect(isCronRequestAuthorized("Bearer keep-alive-secret", "   ")).toBe(false);
    expect(isCronRequestAuthorized(null, "keep-alive-secret")).toBe(false);
    expect(isCronRequestAuthorized("Bearer other", "keep-alive-secret")).toBe(false);
    expect(isCronRequestAuthorized("keep-alive-secret", "keep-alive-secret")).toBe(false);
  });
});
