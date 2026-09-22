import { beforeEach, describe, expect, it, vi } from "vitest";

const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    get: getMock,
    create: vi.fn(),
    getOrCreate: vi.fn(),
  },
}));

vi.mock("./app-server-boot", () => ({
  resumeVercelPreview: vi.fn(),
}));

vi.mock("./workspace-root", () => ({
  ensureVercelWorkspaceRoot: vi.fn(),
}));

vi.mock("./client", () => ({
  vercelAuthOptions: () => ({}),
}));

import { peekVercelSandbox, vercelSandboxExists } from "./vm";

describe("peekVercelSandbox / exists", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is live when status is running", async () => {
    getMock.mockResolvedValue({ name: "sess-1", status: "running" });
    await expect(peekVercelSandbox("sess-1")).resolves.toMatchObject({
      state: "live",
      status: "running",
    });
    await expect(vercelSandboxExists("sess-1")).resolves.toBe(true);
  });

  it("is gone when status is stopped (cannot resume persistent:false)", async () => {
    getMock.mockResolvedValue({ name: "sess-1", status: "stopped" });
    await expect(peekVercelSandbox("sess-1")).resolves.toMatchObject({
      state: "gone",
      status: "stopped",
    });
    await expect(vercelSandboxExists("sess-1")).resolves.toBe(false);
  });

  it("is gone on 410 SANDBOX_STOPPED", async () => {
    getMock.mockRejectedValue(
      new Error(
        "This sandbox was stopped and is no longer reachable.\n410 SANDBOX_STOPPED",
      ),
    );
    await expect(peekVercelSandbox("sess-1")).resolves.toMatchObject({
      state: "gone",
    });
    await expect(vercelSandboxExists("sess-1")).resolves.toBe(false);
  });

  it("is gone when resume is impossible without a snapshot", async () => {
    getMock.mockRejectedValue(
      new Error(
        "Status code 400 is not ok: Cannot resume sandbox: no snapshot available.",
      ),
    );
    await expect(peekVercelSandbox("sess-1")).resolves.toMatchObject({
      state: "gone",
    });
    await expect(vercelSandboxExists("sess-1")).resolves.toBe(false);
  });

  it("is unknown (not gone) on a transient get failure", async () => {
    getMock.mockRejectedValue(new Error("network timeout"));
    await expect(peekVercelSandbox("sess-1")).resolves.toMatchObject({
      state: "unknown",
    });
    await expect(vercelSandboxExists("sess-1")).resolves.toBe(true);
  });
});
