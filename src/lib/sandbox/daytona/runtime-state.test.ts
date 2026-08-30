import { describe, expect, it } from "vitest";

import {
  deriveAllStatus,
  deriveAppServerStatus,
  deriveSandboxStatus,
  emptyRuntimeSnapshot,
  hasFreshPreviewEmbed,
  isDesiredSatisfied,
  resolveTargetDesired,
  runtimePatchChangesState,
  type DaytonaRuntimeSnapshot,
} from "./runtime-state";

function snap(
  patch: Partial<DaytonaRuntimeSnapshot>,
): DaytonaRuntimeSnapshot {
  return { ...emptyRuntimeSnapshot("sess_x"), ...patch };
}

describe("runtime-state derive*", () => {
  it("maps preview-ready + url to public ready status", () => {
    const s = snap({
      sandboxId: "sb_1",
      observed: "preview-ready",
      desired: "preview-ready",
      previewUrl: "https://embed.example/ready",
      previewPort: 3000,
    });
    expect(deriveSandboxStatus(s)).toBe("running");
    expect(deriveAppServerStatus(s)).toEqual({
      status: "ready",
      url: "https://embed.example/ready",
      port: 3000,
    });
    expect(deriveAllStatus(s).previewUrl).toEqual({
      status: "ready",
      url: "https://embed.example/ready",
    });
  });

  it("maps starting phases for UI polling", () => {
    expect(
      deriveAppServerStatus(snap({ observed: "installing-deps", previewPort: 3000 }))
        .status,
    ).toBe("starting");
    expect(
      deriveAppServerStatus(
        snap({ observed: "starting-devserver", previewPort: 3000 }),
      ),
    ).toMatchObject({ status: "starting", port: 3000 });
    expect(
      deriveAppServerStatus(
        snap({
          observed: "starting-devserver",
          previewPort: 3000,
          previewUrl: "https://embed.example",
        }),
      ),
    ).toEqual({
      status: "starting",
      port: 3000,
      url: "https://embed.example",
    });
  });

  it("shows starting while desired=preview-ready during create/bootstrap", () => {
    const s = snap({
      desired: "preview-ready",
      observed: "creating-sandbox",
      sandboxId: null,
    });
    expect(deriveAppServerStatus(s).status).toBe("starting");
  });

  it("legacy installing-deps exposes previewUrl as starting for early iframe", () => {
    const s = snap({
      desired: "preview-ready",
      observed: "installing-deps",
      sandboxId: "sb_1",
      previewUrl: "https://embed.example/early",
      previewPort: 3000,
    });
    expect(deriveAppServerStatus(s)).toEqual({
      status: "starting",
      port: 3000,
      url: "https://embed.example/early",
    });
  });

  it("surfaces lastError when observed=error", () => {
    const s = snap({
      observed: "error",
      lastError: "boom",
      sandboxId: "sb_1",
    });
    expect(deriveAppServerStatus(s)).toEqual({
      status: "error",
      error: "boom",
    });
    expect(deriveSandboxStatus(s)).toBe("error");
  });
});

describe("isDesiredSatisfied", () => {
  it("deleted requires missing + no sandboxId", () => {
    expect(
      isDesiredSatisfied(
        snap({ desired: "deleted", observed: "missing", sandboxId: null }),
      ),
    ).toBe(true);
    expect(
      isDesiredSatisfied(
        snap({
          desired: "deleted",
          observed: "missing",
          sandboxId: "sb_still_there",
        }),
      ),
    ).toBe(false);
  });

  it("stopped is satisfied when workspace-ready without preview", () => {
    expect(
      isDesiredSatisfied(
        snap({
          desired: "stopped",
          observed: "workspace-ready",
          sandboxId: "sb_1",
          previewUrl: null,
        }),
      ),
    ).toBe(true);
    expect(
      isDesiredSatisfied(
        snap({
          desired: "stopped",
          observed: "preview-ready",
          sandboxId: "sb_1",
          previewUrl: "https://x",
          previewPort: 3000,
        }),
      ),
    ).toBe(false);
    expect(
      isDesiredSatisfied(
        snap({
          desired: "stopped",
          observed: "creating-sandbox",
          sandboxId: null,
        }),
      ),
    ).toBe(false);
  });

  it("sandbox-ready accepts workspace or preview phases with sandboxId", () => {
    expect(
      isDesiredSatisfied(
        snap({
          desired: "sandbox-ready",
          observed: "workspace-ready",
          sandboxId: "sb_1",
        }),
      ),
    ).toBe(true);
    expect(
      isDesiredSatisfied(
        snap({
          desired: "sandbox-ready",
          observed: "workspace-ready",
          sandboxId: null,
        }),
      ),
    ).toBe(false);
  });

  it("preview-ready requires url + port", () => {
    expect(
      isDesiredSatisfied(
        snap({
          desired: "preview-ready",
          observed: "preview-ready",
          previewUrl: "https://x",
          previewPort: 3000,
        }),
      ),
    ).toBe(true);
    expect(
      isDesiredSatisfied(
        snap({
          desired: "preview-ready",
          observed: "preview-ready",
          previewUrl: null,
          previewPort: 3000,
        }),
      ),
    ).toBe(false);
  });

  it("clearNextCache blocks satisfaction so restart can re-run start", () => {
    expect(
      isDesiredSatisfied(
        snap({
          desired: "preview-ready",
          observed: "preview-ready",
          previewUrl: "https://x",
          previewPort: 3000,
          clearNextCache: true,
        }),
      ),
    ).toBe(false);
  });
});

describe("hasFreshPreviewEmbed", () => {
  it("accepts preview-ready with public preview url", () => {
    expect(
      hasFreshPreviewEmbed(
        snap({
          observed: "preview-ready",
          previewUrl: "https://preview.example",
          previewPort: 3000,
        }),
      ),
    ).toBe(true);
  });

  it("ignores legacy expiry field; rejects missing url", () => {
    expect(
      hasFreshPreviewEmbed(
        snap({
          observed: "preview-ready",
          previewUrl: "https://preview.example",
          previewPort: 3000,
        }),
      ),
    ).toBe(true);
    expect(
      hasFreshPreviewEmbed(
        snap({
          observed: "preview-ready",
          previewUrl: null,
          previewPort: 3000,
        }),
      ),
    ).toBe(false);
  });
});

describe("resolveTargetDesired", () => {
  it("keeps warm ladder monotonic (sandbox-ready ⊑ preview-ready)", () => {
    expect(resolveTargetDesired("preview-ready", "sandbox-ready")).toBe(
      "preview-ready",
    );
    expect(resolveTargetDesired("sandbox-ready", "preview-ready")).toBe(
      "preview-ready",
    );
    expect(resolveTargetDesired("sandbox-ready", "sandbox-ready")).toBe(
      "sandbox-ready",
    );
  });

  it("lets explicit teardown win when requested", () => {
    expect(resolveTargetDesired("preview-ready", "stopped")).toBe("stopped");
    expect(resolveTargetDesired("sandbox-ready", "deleted")).toBe("deleted");
  });

  it("re-warms after stop on a fresh call, but adopts stop on CAS retry", () => {
    expect(resolveTargetDesired("stopped", "preview-ready")).toBe(
      "preview-ready",
    );
    expect(
      resolveTargetDesired("stopped", "sandbox-ready", { casRetry: true }),
    ).toBe("stopped");
    expect(
      resolveTargetDesired("deleted", "preview-ready", { casRetry: true }),
    ).toBe("deleted");
  });

  it("restart bypasses merge", () => {
    expect(
      resolveTargetDesired("preview-ready", "sandbox-ready", {
        restart: true,
      }),
    ).toBe("sandbox-ready");
  });
});

describe("runtimePatchChangesState", () => {
  it("ignores lastObservedAt-only patches", () => {
    const current = snap({
      observed: "starting-devserver",
      sandboxId: "sb_1",
      lastObservedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(
      runtimePatchChangesState(current, {
        observed: "starting-devserver",
        sandboxId: "sb_1",
        lastObservedAt: "2026-01-01T00:00:01.000Z",
        lastError: null,
      }),
    ).toBe(false);
  });

  it("detects observed phase changes", () => {
    const current = snap({
      observed: "starting-devserver",
      sandboxId: "sb_1",
    });
    expect(
      runtimePatchChangesState(current, {
        observed: "preview-ready",
        sandboxId: "sb_1",
      }),
    ).toBe(true);
  });
});
