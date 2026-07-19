import { describe, expect, it } from "vitest";

import { canFastAttachSandbox } from "./sandbox";
import {
  emptyRuntimeSnapshot,
  type DaytonaRuntimeSnapshot,
} from "./runtime-state";

function snap(
  patch: Partial<DaytonaRuntimeSnapshot>,
): DaytonaRuntimeSnapshot {
  return { ...emptyRuntimeSnapshot("sess_x"), ...patch };
}

describe("canFastAttachSandbox", () => {
  it("allows attach when workspace/preview already observed", () => {
    expect(
      canFastAttachSandbox(
        snap({
          sandboxId: "sb_1",
          observed: "preview-ready",
          desired: "preview-ready",
        }),
      ),
    ).toBe(true);
    expect(
      canFastAttachSandbox(
        snap({
          sandboxId: "sb_1",
          observed: "workspace-ready",
          desired: "sandbox-ready",
        }),
      ),
    ).toBe(true);
  });

  it("rejects missing sandbox or deleted desired", () => {
    expect(
      canFastAttachSandbox(
        snap({ sandboxId: null, observed: "missing", desired: "sandbox-ready" }),
      ),
    ).toBe(false);
    expect(
      canFastAttachSandbox(
        snap({
          sandboxId: "sb_1",
          observed: "preview-ready",
          desired: "deleted",
        }),
      ),
    ).toBe(false);
  });

  it("rejects create before sandboxId is written", () => {
    expect(
      canFastAttachSandbox(
        snap({
          sandboxId: null,
          observed: "creating-sandbox",
          desired: "preview-ready",
        }),
      ),
    ).toBe(false);
  });

  it("allows attach once sandboxId exists during warm bootstrap/install", () => {
    expect(
      canFastAttachSandbox(
        snap({
          sandboxId: "sb_1",
          observed: "bootstrapping-workspace",
          desired: "preview-ready",
        }),
      ),
    ).toBe(true);
    expect(
      canFastAttachSandbox(
        snap({
          sandboxId: "sb_1",
          observed: "installing-deps",
          desired: "preview-ready",
        }),
      ),
    ).toBe(true);
  });
});
