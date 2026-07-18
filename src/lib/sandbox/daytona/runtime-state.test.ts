import { describe, expect, it } from "vitest";

import {
  deriveAllStatus,
  deriveAppServerStatus,
  deriveSandboxStatus,
  emptyRuntimeSnapshot,
  hasFreshPreviewEmbed,
  isDesiredSatisfied,
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

  it("maps installing / starting phases for UI polling", () => {
    expect(
      deriveAppServerStatus(snap({ observed: "installing-deps" })).status,
    ).toBe("installing");
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
          previewExpiresAtMs: Date.now() + 60_000,
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
