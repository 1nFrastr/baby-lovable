/**
 * checkRuntimePreview: HTTP-only. Application 500 → ready (ok:false upstream);
 * 502/503 stay starting. Log text is on-demand via readLog — no remote log read here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeSession, withMemoryRuntime } from "./__tests__/test-helpers";

const {
  ctx,
  reconnectSandbox,
  wrapSandbox,
  observeRuntime,
  httpStatus,
} = vi.hoisted(() => {
  const ctx = { sessionId: "" };
  return {
    ctx,
    reconnectSandbox: vi.fn(),
    wrapSandbox: vi.fn(),
    observeRuntime: vi.fn(),
    httpStatus: vi.fn(),
  };
});

vi.mock("@/lib/session/store", () => ({
  getSession: vi.fn(async (id: string) =>
    id === ctx.sessionId ? makeSession(id) : null,
  ),
  getSessionOwner: vi.fn(async (id: string) =>
    id === ctx.sessionId
      ? { userId: null, sandboxMode: "daytona" as const }
      : null,
  ),
  updateSession: vi.fn(async () => makeSession(ctx.sessionId)),
}));

vi.mock("@/lib/session/runtime-projection-store", () => ({
  publishRuntimeUpdate: vi.fn(),
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
}));

vi.mock("./app-server-health", () => ({
  remoteFileExists: vi.fn(),
  httpStatus,
  PREVIEW_HTTP_TIMEOUT_MS: 1_500,
  STARTING_DEV_HTTP_TIMEOUT_MS: 1_500,
}));

vi.mock("./app-server-boot", () => ({
  formatStartError: (e: unknown) =>
    e instanceof Error ? e.message : String(e),
  startDevSession: vi.fn(),
  stopDevSession: vi.fn(),
}));

import { checkRuntimePreview } from "./runtime-reconciler";
import { upsertRuntimeSnapshot, withFreshIsolate } from "./runtime-store";
import type { ObservedRuntime } from "./runtime-observer";

function observed(partial: Partial<ObservedRuntime>): ObservedRuntime {
  return {
    phase: "missing",
    sandboxId: null,
    sandboxState: null,
    previewUrl: null,
    previewPort: null,
    probeUrl: null,
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
    httpStatus.mockResolvedValue(200);
  });

  it("fast path: HTTP-only — no reconnect, no observe", async () => {
    await withMemoryRuntime(async ({ sessionId }) => {
      ctx.sessionId = sessionId;

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

      expect(report).toEqual({
        status: "ready",
        url: PREVIEW_URL,
        buildError: null,
        httpStatus: 200,
      });
      expect(observeRuntime).not.toHaveBeenCalled();
      expect(reconnectSandbox).not.toHaveBeenCalled();
      expect(httpStatus).toHaveBeenCalledWith(PREVIEW_URL);
    });
  });

  it("fast path: HTTP 502 stays starting (no log diagnosis)", async () => {
    await withMemoryRuntime(async ({ sessionId }) => {
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

      expect(report).toEqual({
        status: "starting",
        url: PREVIEW_URL,
        buildError: null,
        httpStatus: 502,
      });
      expect(reconnectSandbox).not.toHaveBeenCalled();
    });
  });

  it("fast path: HTTP 500 is ready without buildError (use readLog)", async () => {
    await withMemoryRuntime(async ({ sessionId }) => {
      ctx.sessionId = sessionId;
      httpStatus.mockResolvedValue(500);

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

      expect(report).toEqual({
        status: "ready",
        url: PREVIEW_URL,
        buildError: null,
        httpStatus: 500,
      });
      expect(reconnectSandbox).not.toHaveBeenCalled();
    });
  });

  it("full path: observe HTTP 500 → ready without log read", async () => {
    await withMemoryRuntime(async ({ sessionId }) => {
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
          previewUrl: PREVIEW_URL,
          previewPort: 3000,
          probeUrl: PREVIEW_URL,
          httpStatus: 500,
        }),
      );

      const report = await withFreshIsolate(sessionId, () =>
        checkRuntimePreview(sessionId),
      );

      expect(report).toEqual({
        status: "ready",
        url: PREVIEW_URL,
        buildError: null,
        httpStatus: 500,
      });
      expect(observeRuntime).toHaveBeenCalledTimes(1);
    });
  });

  it("full path: observe HTTP 200 → ready", async () => {
    await withMemoryRuntime(async ({ sessionId }) => {
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
          previewUrl: PREVIEW_URL,
          previewPort: 3000,
          probeUrl: PREVIEW_URL,
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
    });
  });
});
