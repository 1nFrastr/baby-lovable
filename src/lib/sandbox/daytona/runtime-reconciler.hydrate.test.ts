/**
 * Freestyle hydrate vs startDev ordering — new sessions defer hydrate;
 * recreate (remoteHeadSha set) still blocks before workspace-ready.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeSession, withMemoryRuntime } from "./__tests__/test-helpers";

const {
  ctx,
  createSandbox,
  deleteSandboxById,
  reconnectSandbox,
  sandboxRecordExists,
  wrapSandbox,
  ensureSandboxPublic,
  startDevSession,
  stopDevSession,
  observeRuntime,
  httpStatus,
  isFreestyleConfigured,
  readGitRepository,
  hydrateWorkspaceFromFreestyle,
} = vi.hoisted(() => {
  const ctx = { sessionId: "" };
  return {
    ctx,
    createSandbox: vi.fn(),
    deleteSandboxById: vi.fn(),
    reconnectSandbox: vi.fn(),
    sandboxRecordExists: vi.fn(async () => true),
    wrapSandbox: vi.fn(),
    ensureSandboxPublic: vi.fn(async () => {}),
    startDevSession: vi.fn(),
    stopDevSession: vi.fn(),
    observeRuntime: vi.fn(),
    httpStatus: vi.fn(async () => 200),
    isFreestyleConfigured: vi.fn(() => true),
    readGitRepository: vi.fn(),
    hydrateWorkspaceFromFreestyle: vi.fn(),
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
  createSandbox,
  deleteSandboxById,
  reconnectSandbox,
  sandboxRecordExists,
  wrapSandbox,
  ensureSandboxPublic,
  isAsleep: (state: string | undefined) =>
    state === "stopped" || state === "archived",
}));

vi.mock("./app-server-boot", () => ({
  DEV_SESSION: (sessionId: string) => `preview-${sessionId}`,
  formatStartError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  startDevSession,
  stopDevSession,
}));

vi.mock("./app-server-health", () => ({
  httpStatus,
  PREVIEW_HTTP_TIMEOUT_MS: 1_500,
  STARTING_DEV_HTTP_TIMEOUT_MS: 1_500,
}));

vi.mock("./runtime-observer", () => ({
  observeRuntime,
}));

vi.mock("@/lib/git/freestyle-config", () => ({
  isFreestyleConfigured,
}));

vi.mock("@/lib/git/repository-store", () => ({
  readGitRepository,
}));

vi.mock("@/lib/git/hydrate-workspace", () => ({
  hydrateWorkspaceFromFreestyle,
}));

import { ensureDesiredState } from "./runtime-reconciler";
import { getRuntimeSnapshot, withFreshIsolate } from "./runtime-store";
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

const fakeProject = {
  id: "proj",
  sdkSandbox: { id: "sb_1", delete: vi.fn() },
  process: { executeCommand: vi.fn() },
  git: {},
};

describe("runtime-reconciler Freestyle hydrate deferral", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isFreestyleConfigured.mockReturnValue(true);
    createSandbox.mockImplementation(async () => ({
      id: "sb_1",
      state: "started",
      public: true,
      getPreviewLink: async () => ({ url: "https://preview.example/app" }),
    }));
    reconnectSandbox.mockResolvedValue({
      id: "sb_1",
      state: "started",
      public: true,
      getPreviewLink: async () => ({ url: "https://preview.example/app" }),
    });
    wrapSandbox.mockReturnValue(fakeProject);
    startDevSession.mockResolvedValue({
      sessionName: "preview-sess",
      port: 3000,
    });
    stopDevSession.mockResolvedValue(undefined);
    deleteSandboxById.mockResolvedValue(undefined);
    sandboxRecordExists.mockResolvedValue(true);
    httpStatus.mockResolvedValue(200);
    hydrateWorkspaceFromFreestyle.mockResolvedValue({
      ok: true,
      remoteHeadSha: "abc",
      mode: "pull",
    });
  });

  it("new session (no remoteHeadSha) starts pnpm before hydrate finishes", async () => {
    await withMemoryRuntime(async ({ sessionId }) => {
      ctx.sessionId = sessionId;

      let releaseHydrate!: () => void;
      const hydrateGate = new Promise<void>((resolve) => {
        releaseHydrate = resolve;
      });
      hydrateWorkspaceFromFreestyle.mockImplementation(async () => {
        await hydrateGate;
        return { ok: true, remoteHeadSha: "seed", mode: "pull" };
      });
      readGitRepository.mockResolvedValue({
        remoteHeadSha: null,
        provisionStatus: "preparing",
      });

      let started = false;
      observeRuntime.mockImplementation(async (_sid, opts) => {
        const snap = opts?.snapshot ?? (await getRuntimeSnapshot(sessionId));
        if (started || snap.devSessionName) {
          return observed({
            phase: "preview-ready",
            sandboxId: "sb_1",
            previewUrl: "https://preview.example/app",
            previewPort: 3000,
            httpStatus: 200,
          });
        }
        if (snap.sandboxId) {
          return observed({
            phase: "workspace-ready",
            sandboxId: "sb_1",
            previewUrl: "https://preview.example/app",
            previewPort: 3000,
            httpStatus: 503,
          });
        }
        return observed({ phase: "missing" });
      });
      startDevSession.mockImplementation(async () => {
        started = true;
        return { sessionName: "preview-sess", port: 3000 };
      });

      const ensurePromise = withFreshIsolate(sessionId, () =>
        ensureDesiredState(sessionId, "preview-ready", {
          wait: true,
          owner: "hydrate-defer-new",
        }),
      );

      await vi.waitFor(() => {
        expect(startDevSession).toHaveBeenCalled();
      });
      expect(hydrateWorkspaceFromFreestyle).toHaveBeenCalled();
      // Hydrate still blocked — startDev must not have waited on it.
      releaseHydrate();

      const result = await ensurePromise;
      expect(result.observed).toBe("preview-ready");
      expect(result.sandboxId).toBe("sb_1");
    });
  });

  it("recreate (remoteHeadSha set) awaits hydrate before startDev", async () => {
    await withMemoryRuntime(async ({ sessionId }) => {
      ctx.sessionId = sessionId;

      let hydrateStarted = false;
      let releaseHydrate!: () => void;
      const hydrateGate = new Promise<void>((resolve) => {
        releaseHydrate = resolve;
      });
      const order: string[] = [];

      hydrateWorkspaceFromFreestyle.mockImplementation(async () => {
        hydrateStarted = true;
        order.push("hydrate-start");
        await hydrateGate;
        order.push("hydrate-end");
        return { ok: true, remoteHeadSha: "user-sha", mode: "pull" };
      });
      readGitRepository.mockResolvedValue({
        remoteHeadSha: "user-sha",
        provisionStatus: "ready",
      });

      let started = false;
      observeRuntime.mockImplementation(async (_sid, opts) => {
        const snap = opts?.snapshot ?? (await getRuntimeSnapshot(sessionId));
        if (started || snap.devSessionName) {
          return observed({
            phase: "preview-ready",
            sandboxId: "sb_1",
            previewUrl: "https://preview.example/app",
            previewPort: 3000,
            httpStatus: 200,
          });
        }
        if (snap.sandboxId && snap.observed === "workspace-ready") {
          return observed({
            phase: "workspace-ready",
            sandboxId: "sb_1",
            previewUrl: "https://preview.example/app",
            previewPort: 3000,
            httpStatus: 503,
          });
        }
        if (snap.sandboxId) {
          return observed({
            phase: "workspace-ready",
            sandboxId: "sb_1",
            previewUrl: "https://preview.example/app",
            previewPort: 3000,
            httpStatus: 503,
          });
        }
        return observed({ phase: "missing" });
      });
      startDevSession.mockImplementation(async () => {
        order.push("startDev");
        started = true;
        return { sessionName: "preview-sess", port: 3000 };
      });

      const ensurePromise = withFreshIsolate(sessionId, () =>
        ensureDesiredState(sessionId, "preview-ready", {
          wait: true,
          owner: "hydrate-block-recreate",
        }),
      );

      await vi.waitFor(() => {
        expect(hydrateStarted).toBe(true);
      });
      // Blocking path: startDev must not run until hydrate completes.
      expect(startDevSession).not.toHaveBeenCalled();
      releaseHydrate();

      const result = await ensurePromise;
      expect(result.observed).toBe("preview-ready");
      expect(order.indexOf("hydrate-end")).toBeLessThan(order.indexOf("startDev"));
      expect(order.indexOf("hydrate-start")).toBeLessThan(order.indexOf("hydrate-end"));
    });
  });
});
