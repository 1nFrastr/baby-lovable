import { afterEach, describe, expect, it } from "vitest";

import {
  VERCEL_DEFAULT_IMAGE,
  VERCEL_DEFAULT_IDLE_MINUTES,
  VERCEL_DEFAULT_VCPUS,
  VERCEL_IDLE_EXTEND_SLACK_MS,
  getVercelIdleMs,
  getVercelResources,
  getVercelNetworkPolicy,
  getVercelSandboxImage,
  isVercelSandboxConfigured,
  vercelIdleExtendMs,
  vercelSandboxName,
} from "./config";

describe("vercel sandbox config", () => {
  afterEach(() => {
    delete process.env.SANDBOX_IDLE_MINUTES;
    delete process.env.VERCEL_SANDBOX_IDLE_MINUTES;
    delete process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_PROJECT_ID;
    delete process.env.VERCEL_OIDC_TOKEN;
    delete process.env.VERCEL;
    delete process.env.VERCEL_SANDBOX_IMAGE;
    delete process.env.VERCEL_SANDBOX_VCPUS;
    delete process.env.VERCEL_SANDBOX_ALLOW_HOSTS;
  });

  it("sanitizes session ids into sandbox names", () => {
    expect(vercelSandboxName("sess_AbC123")).toBe("sess-abc123");
    expect(vercelSandboxName("sess_AbC123", "xyz")).toBe("sess-abc123-xyz");
  });

  it("defaults Vercel idle to 15 minutes", () => {
    expect(getVercelIdleMs()).toBe(VERCEL_DEFAULT_IDLE_MINUTES * 60 * 1000);
    expect(VERCEL_DEFAULT_IDLE_MINUTES).toBe(15);
  });

  it("computes idle timeout from minutes", () => {
    process.env.SANDBOX_IDLE_MINUTES = "20";
    expect(getVercelIdleMs()).toBe(20 * 60 * 1000);
  });

  it("does not treat idle 0 as unbounded", () => {
    process.env.SANDBOX_IDLE_MINUTES = "0";
    expect(getVercelIdleMs()).toBe(VERCEL_DEFAULT_IDLE_MINUTES * 60 * 1000);
  });

  it("tops remaining lifetime up to idle, and does not stack when fresh", () => {
    const idleMs = VERCEL_DEFAULT_IDLE_MINUTES * 60 * 1000;
    const now = 1_000_000;
    expect(
      vercelIdleExtendMs({
        now,
        idleMs,
        expiresAt: new Date(now + idleMs),
      }),
    ).toBe(0);
    expect(
      vercelIdleExtendMs({
        now,
        idleMs,
        expiresAt: new Date(now + idleMs - VERCEL_IDLE_EXTEND_SLACK_MS / 2),
      }),
    ).toBe(0);
    expect(
      vercelIdleExtendMs({
        now,
        idleMs,
        expiresAt: new Date(now + 5 * 60 * 1000),
      }),
    ).toBe(idleMs - 5 * 60 * 1000);
    expect(vercelIdleExtendMs({ now, idleMs, expiresAt: null })).toBe(0);
  });

  it("defaults to 1 vCPU (2 GiB RAM)", () => {
    delete process.env.VERCEL_SANDBOX_VCPUS;
    expect(getVercelResources()).toEqual({ vcpus: VERCEL_DEFAULT_VCPUS });
  });

  it("defaults to the baby-lovable VCR image, not vercel/sandbox/universal", () => {
    delete process.env.VERCEL_SANDBOX_IMAGE;
    expect(getVercelSandboxImage()).toBe(VERCEL_DEFAULT_IMAGE);
    process.env.VERCEL_SANDBOX_IMAGE = "vercel/sandbox/universal";
    expect(getVercelSandboxImage()).toBe("vercel/sandbox/universal");
  });

  it("allows Keenable API egress by default", () => {
    delete process.env.VERCEL_SANDBOX_ALLOW_HOSTS;
    const policy = getVercelNetworkPolicy();
    expect(policy).not.toBe("allow-all");
    if (policy !== "allow-all") {
      expect(policy.allow).toContain("api.keenable.ai");
    }
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
