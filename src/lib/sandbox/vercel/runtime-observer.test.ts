import { beforeEach, describe, expect, it, vi } from "vitest";

const { peekVercelSandbox, wrapVercelSandbox, getRuntimeSnapshot } = vi.hoisted(
  () => ({
    peekVercelSandbox: vi.fn(),
    wrapVercelSandbox: vi.fn(),
    getRuntimeSnapshot: vi.fn(),
  }),
);

vi.mock("./vm", () => ({
  peekVercelSandbox,
  wrapVercelSandbox,
}));

vi.mock("../daytona/runtime-store", () => ({
  getRuntimeSnapshot,
}));

vi.mock("../daytona/app-server-health", () => ({
  PREVIEW_HTTP_TIMEOUT_MS: 1_500,
}));

vi.mock("./config", () => ({
  getVercelDevPort: () => 3000,
}));

import { observeVercelRuntime } from "./runtime-observer";
import type { DaytonaRuntimeSnapshot } from "../daytona/runtime-state";

function snap(
  partial: Partial<DaytonaRuntimeSnapshot> = {},
): DaytonaRuntimeSnapshot {
  return {
    sessionId: "sess_obs",
    desired: "preview-ready",
    observed: "preview-ready",
    provider: "vercel",
    providerMeta: {},
    sandboxId: "sess-obs",
    devSessionName: "preview",
    devCmdId: null,
    previewUrl: "https://preview.example/app",
    previewPort: 3000,
    lastError: null,
    generation: 1,
    revision: 1,
    clearNextCache: false,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastObservedAt: null,
    ...partial,
  };
}

describe("observeVercelRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRuntimeSnapshot.mockResolvedValue(snap());
  });

  it("marks confirmedAbsent when peek reports SANDBOX_STOPPED", async () => {
    peekVercelSandbox.mockResolvedValue({
      state: "gone",
      reason:
        "Vercel sandbox stopped or deleted externally (410 SANDBOX_STOPPED)",
      status: "stopped",
    });

    const result = await observeVercelRuntime("sess_obs", {
      snapshot: snap(),
    });

    expect(result).toMatchObject({
      phase: "missing",
      sandboxId: null,
      confirmedAbsent: true,
    });
    expect(result.lastError).toMatch(/stopped or deleted/i);
    expect(wrapVercelSandbox).not.toHaveBeenCalled();
  });

  it("keeps the id as a transient miss when peek is inconclusive", async () => {
    peekVercelSandbox.mockResolvedValue({
      state: "unknown",
      reason: "fetch failed",
    });

    const result = await observeVercelRuntime("sess_obs", {
      snapshot: snap(),
    });

    expect(result).toMatchObject({
      phase: "workspace-ready",
      sandboxId: "sess-obs",
      transient: true,
    });
    expect(result.confirmedAbsent).toBeUndefined();
  });

  it("marks confirmedAbsent when a live sandbox's preview proxy returns 410", async () => {
    peekVercelSandbox.mockResolvedValue({
      state: "live",
      status: "running",
      sandbox: { name: "sess-obs", status: "running" },
    });
    wrapVercelSandbox.mockReturnValue({
      sdkSandbox: {
        name: "sess-obs",
        status: "running",
        domain: () => "https://preview.example/app",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 410,
        body: { cancel: async () => {} },
      })),
    );

    const result = await observeVercelRuntime("sess_obs", {
      snapshot: snap(),
    });

    expect(result).toMatchObject({
      phase: "missing",
      confirmedAbsent: true,
      httpStatus: 410,
    });
    vi.unstubAllGlobals();
  });
});
