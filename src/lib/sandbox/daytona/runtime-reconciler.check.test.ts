/**
 * checkRuntimePreview: ready requires HTTP < 500; fast path skips full observe.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeSession, withTempDataDir } from "./__tests__/test-helpers";

const {
  ctx,
  reconnectSandbox,
  wrapSandbox,
  observeRuntime,
  readDevLog,
  extractCompileError,
  httpStatus,
} = vi.hoisted(() => {
  const ctx = { sessionId: "" };
  return {
    ctx,
    reconnectSandbox: vi.fn(),
    wrapSandbox: vi.fn(),
    observeRuntime: vi.fn(),
    readDevLog: vi.fn(),
    extractCompileError: vi.fn(),
    httpStatus: vi.fn(),
  };
});

vi.mock("@/lib/session/store", () => ({
  getSession: vi.fn(async (id: string) =>
    id === ctx.sessionId ? makeSession(id) : null,
  ),
  updateSession: vi.fn(async () => makeSession(ctx.sessionId)),
}));

vi.mock("./vm", () => ({
  createSandbox: vi.fn(),
  deleteSandboxById: vi.fn(),
  reconnectSandbox,
  wrapSandbox,
  isAsleep: () => false,
}));

vi.mock("./runtime-observer", () => ({
  observeRuntime,
  observePreviewHealth: vi.fn(),
}));

vi.mock("./app-server-health", () => ({
  readDevLog,
  extractCompileError,
  remoteFileExists: vi.fn(),
  httpStatus,
}));

vi.mock("./workspace-bootstrap", () => ({
  ensureDaytonaWorkspace: vi.fn(),
}));

vi.mock("./app-server-boot", () => ({
  formatStartError: (e: unknown) =>
    e instanceof Error ? e.message : String(e),
  installDeps: vi.fn(),
  startDevSession: vi.fn(),
  stopDevSession: vi.fn(),
}));

vi.mock("../workspace-git", () => ({
  commitWorkspaceTurn: vi.fn(),
}));

import { checkRuntimePreview } from "./runtime-reconciler";
import { upsertRuntimeSnapshot, withFreshIsolate } from "./runtime-store";
import type { ObservedRuntime } from "./runtime-observer";

function observed(partial: Partial<ObservedRuntime>): ObservedRuntime {
  return {
    phase: "missing",
    sandboxId: null,
    sandboxState: null,
    hasPackageJson: false,
    hasNodeModules: false,
    previewUrl: null,
    previewPort: null,
    previewExpiresAtMs: null,
    probeUrl: null,
    previewToken: null,
    buildError: null,
    httpStatus: null,
    lastError: null,
    ...partial,
  };
}

const PREVIEW_URL = "https://3000-sb.daytonaproxy.example";

describe("checkRuntimePreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reconnectSandbox.mockResolvedValue({ id: "sb_1", state: "started" });
    wrapSandbox.mockReturnValue({ id: "proj" });
    readDevLog.mockResolvedValue("ok log");
    extractCompileError.mockReturnValue(null);
    httpStatus.mockResolvedValue(200);
  });

  it("fast path: skips observeRuntime; ready only when HTTP < 500", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      ctx.sessionId = sessionId;

      await withFreshIsolate(sessionId, () =>
        upsertRuntimeSnapshot(sessionId, {
          desired: "preview-ready",
          observed: "preview-ready",
          sandboxId: "sb_1",
          previewUrl: PREVIEW_URL,
          previewPort: 3000,
          previewExpiresAtMs: null,
        }),
      );

      const report = await withFreshIsolate(sessionId, () =>
        checkRuntimePreview(sessionId),
      );

      expect(report).toEqual({
        status: "ready",
        url: PREVIEW_URL,
        buildError: null,
        httpStatus: 200,
      });
      expect(observeRuntime).not.toHaveBeenCalled();
      expect(readDevLog).toHaveBeenCalledTimes(1);
      expect(httpStatus).toHaveBeenCalledWith(PREVIEW_URL);
    });
  });

  it("fast path: HTTP 502 is starting, not ready", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      ctx.sessionId = sessionId;
      httpStatus.mockResolvedValue(502);

      await withFreshIsolate(sessionId, () =>
        upsertRuntimeSnapshot(sessionId, {
          desired: "preview-ready",
          observed: "preview-ready",
          sandboxId: "sb_1",
          previewUrl: PREVIEW_URL,
          previewPort: 3000,
        }),
      );

      const report = await withFreshIsolate(sessionId, () =>
        checkRuntimePreview(sessionId),
      );

      expect(report.status).toBe("starting");
      expect(report.httpStatus).toBe(502);
      expect(report.url).toBe(PREVIEW_URL);
      expect(observeRuntime).not.toHaveBeenCalled();
    });
  });

  it("fast path surfaces compile error from log", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      ctx.sessionId = sessionId;
      extractCompileError.mockReturnValue("Failed to compile\n...");

      await withFreshIsolate(sessionId, () =>
        upsertRuntimeSnapshot(sessionId, {
          desired: "preview-ready",
          observed: "preview-ready",
          sandboxId: "sb_1",
          previewUrl: PREVIEW_URL,
          previewPort: 3000,
        }),
      );

      const report = await withFreshIsolate(sessionId, () =>
        checkRuntimePreview(sessionId),
      );

      expect(report.status).toBe("ready");
      expect(report.buildError).toBe("Failed to compile\n...");
      expect(report.httpStatus).toBe(200);
      expect(observeRuntime).not.toHaveBeenCalled();
    });
  });

  it("full path when not ready: observe once; 5xx is starting", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      ctx.sessionId = sessionId;

      await withFreshIsolate(sessionId, () =>
        upsertRuntimeSnapshot(sessionId, {
          desired: "preview-ready",
          observed: "starting-devserver",
          sandboxId: "sb_1",
        }),
      );

      observeRuntime.mockResolvedValue(
        observed({
          phase: "preview-ready",
          sandboxId: "sb_1",
          hasPackageJson: true,
          hasNodeModules: true,
          previewUrl: PREVIEW_URL,
          previewPort: 3000,
          probeUrl: PREVIEW_URL,
          buildError: null,
          httpStatus: 502,
        }),
      );

      const report = await withFreshIsolate(sessionId, () =>
        checkRuntimePreview(sessionId),
      );

      expect(report.status).toBe("starting");
      expect(report.httpStatus).toBe(502);
      expect(observeRuntime).toHaveBeenCalledTimes(1);
    });
  });

  it("full path when not ready: observe once, ready on HTTP 200", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      ctx.sessionId = sessionId;

      await withFreshIsolate(sessionId, () =>
        upsertRuntimeSnapshot(sessionId, {
          desired: "preview-ready",
          observed: "starting-devserver",
          sandboxId: "sb_1",
        }),
      );

      observeRuntime.mockResolvedValue(
        observed({
          phase: "preview-ready",
          sandboxId: "sb_1",
          hasPackageJson: true,
          hasNodeModules: true,
          previewUrl: PREVIEW_URL,
          previewPort: 3000,
          probeUrl: PREVIEW_URL,
          buildError: null,
          httpStatus: 200,
        }),
      );

      const report = await withFreshIsolate(sessionId, () =>
        checkRuntimePreview(sessionId),
      );

      expect(report).toEqual({
        status: "ready",
        url: PREVIEW_URL,
        buildError: null,
        httpStatus: 200,
      });
      expect(observeRuntime).toHaveBeenCalledTimes(1);
      expect(readDevLog).not.toHaveBeenCalled();
    });
  });

  it("falls back to full observe when reconnect fails on ready snapshot", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      ctx.sessionId = sessionId;
      reconnectSandbox.mockResolvedValue(null);

      await withFreshIsolate(sessionId, () =>
        upsertRuntimeSnapshot(sessionId, {
          desired: "preview-ready",
          observed: "preview-ready",
          sandboxId: "sb_1",
          previewUrl: PREVIEW_URL,
          previewPort: 3000,
        }),
      );

      observeRuntime.mockResolvedValue(
        observed({
          phase: "preview-ready",
          sandboxId: "sb_1",
          previewUrl: PREVIEW_URL,
          previewPort: 3000,
          probeUrl: PREVIEW_URL,
          buildError: null,
          httpStatus: 200,
        }),
      );

      const report = await withFreshIsolate(sessionId, () =>
        checkRuntimePreview(sessionId),
      );

      expect(report.status).toBe("ready");
      expect(observeRuntime).toHaveBeenCalledTimes(1);
    });
  });
});
