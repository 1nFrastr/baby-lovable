import { afterEach, describe, expect, it } from "vitest";

import {
  getVercelIdleMs,
  isVercelSandboxConfigured,
  vercelSandboxName,
} from "./config";

describe("vercel sandbox config", () => {
  afterEach(() => {
    delete process.env.SANDBOX_IDLE_MINUTES;
    delete process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_PROJECT_ID;
    delete process.env.VERCEL_OIDC_TOKEN;
    delete process.env.VERCEL;
  });

  it("sanitizes session ids into sandbox names", () => {
    expect(vercelSandboxName("sess_AbC123")).toBe("sess-abc123");
  });

  it("computes idle timeout from minutes", () => {
    process.env.SANDBOX_IDLE_MINUTES = "15";
    expect(getVercelIdleMs()).toBe(15 * 60 * 1000);
  });

  it("requires token + team + project for local CLI credentials", () => {
    expect(isVercelSandboxConfigured()).toBe(false);
    process.env.VERCEL_TOKEN = "tok";
    process.env.VERCEL_PROJECT_ID = "prj";
    expect(isVercelSandboxConfigured()).toBe(false);
    process.env.VERCEL_TEAM_ID = "team";
    expect(isVercelSandboxConfigured()).toBe(true);
  });
});
