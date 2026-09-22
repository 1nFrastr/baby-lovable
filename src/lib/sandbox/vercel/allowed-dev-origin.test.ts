import { describe, expect, it } from "vitest";

import { withVercelAllowedDevOrigin } from "./allowed-dev-origin";

describe("withVercelAllowedDevOrigin", () => {
  it("is a no-op when vercel.run is already allowed", () => {
    const src = `allowedDevOrigins: ["*.daytonaproxy01.net", "*.vercel.run"],`;
    expect(withVercelAllowedDevOrigin(src)).toBe(src);
  });

  it("prepends vercel.run onto an existing allowedDevOrigins list", () => {
    const src = `const nextConfig = {\n  allowedDevOrigins: ["*.daytonaproxy01.net"],\n};`;
    expect(withVercelAllowedDevOrigin(src)).toContain(
      `allowedDevOrigins: ["*.vercel.run", "*.daytonaproxy01.net"]`,
    );
  });

  it("inserts allowedDevOrigins when missing", () => {
    const src = `const nextConfig: NextConfig = {\n  turbopack: { root: __dirname },\n};`;
    expect(withVercelAllowedDevOrigin(src)).toContain(
      `allowedDevOrigins: ["*.vercel.run"]`,
    );
  });
});
