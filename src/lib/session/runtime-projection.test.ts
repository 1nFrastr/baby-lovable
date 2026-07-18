import { describe, expect, it } from "vitest";

import {
  emptyRuntimeProjection,
  mergeRuntimeProjection,
  shouldBumpRuntimeVersion,
} from "./runtime-projection";

describe("runtime projection merge / bump", () => {
  it("merges nested patches without changing version", () => {
    const base = emptyRuntimeProjection("sess_1", "2026-01-01T00:00:00.000Z");
    base.version = 3;
    const merged = mergeRuntimeProjection(base, {
      preview: { appServerStatus: "ready", url: "http://localhost:3200" },
      run: { status: "running", runId: "run_1" },
    });

    expect(merged.version).toBe(3);
    expect(merged.preview.appServerStatus).toBe("ready");
    expect(merged.preview.url).toBe("http://localhost:3200");
    expect(merged.preview.sandbox).toBe("missing");
    expect(merged.run.status).toBe("running");
    expect(merged.run.runId).toBe("run_1");
  });

  it("does not bump when only updatedAt changes", () => {
    const before = emptyRuntimeProjection("sess_1", "2026-01-01T00:00:00.000Z");
    const after = mergeRuntimeProjection(before, {
      preview: { updatedAt: "2026-01-02T00:00:00.000Z" },
      run: { updatedAt: "2026-01-02T00:00:00.000Z" },
      appTest: { updatedAt: "2026-01-02T00:00:00.000Z" },
    });

    expect(shouldBumpRuntimeVersion(before, after)).toBe(false);
  });

  it("bumps when UI-visible preview fields change", () => {
    const before = emptyRuntimeProjection("sess_1");
    const after = mergeRuntimeProjection(before, {
      preview: { appServerStatus: "ready", url: "http://localhost:3200" },
    });

    expect(shouldBumpRuntimeVersion(before, after)).toBe(true);
  });

  it("bumps when generation changes", () => {
    const before = emptyRuntimeProjection("sess_1");
    const after = mergeRuntimeProjection(before, {
      preview: { generation: 2 },
    });

    expect(shouldBumpRuntimeVersion(before, after)).toBe(true);
  });

  it("bumps when appTest liveViewUrl appears", () => {
    const before = emptyRuntimeProjection("sess_1");
    const after = mergeRuntimeProjection(before, {
      appTest: {
        status: "running",
        liveViewUrl: "https://example.com/live",
        runId: "t1",
      },
    });

    expect(shouldBumpRuntimeVersion(before, after)).toBe(true);
  });
});
