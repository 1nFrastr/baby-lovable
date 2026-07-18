/**
 * Reconciler races under mocked Daytona — simulates WebUI + agent isolates
 * contending on desired state / lease without a real sandbox.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeSession, withTempDataDir, enterIsolate } from "./__tests__/test-helpers";

const {
  ctx,
  createSandbox,
  deleteSandboxById,
  reconnectSandbox,
  wrapSandbox,
  ensureDaytonaWorkspace,
  installDeps,
  startDevSession,
  stopDevSession,
  observeRuntime,
  commitWorkspaceTurn,
} = vi.hoisted(() => {
  const ctx = { sessionId: "" };
  return {
    ctx,
    createSandbox: vi.fn(),
    deleteSandboxById: vi.fn(),
    reconnectSandbox: vi.fn(),
    wrapSandbox: vi.fn(),
    ensureDaytonaWorkspace: vi.fn(),
    installDeps: vi.fn(),
    startDevSession: vi.fn(),
    stopDevSession: vi.fn(),
    observeRuntime: vi.fn(),
    commitWorkspaceTurn: vi.fn(),
  };
});

vi.mock("@/lib/session/store", () => ({
  getSession: vi.fn(async (id: string) =>
    id === ctx.sessionId ? makeSession(id) : null,
  ),
  updateSession: vi.fn(async () => makeSession(ctx.sessionId)),
}));

vi.mock("../workspace-git", () => ({
  commitWorkspaceTurn,
}));

vi.mock("./vm", () => ({
  createSandbox,
  deleteSandboxById,
  reconnectSandbox,
  wrapSandbox,
  isAsleep: (state: string | undefined) =>
    state === "stopped" || state === "archived",
}));

vi.mock("./workspace-bootstrap", () => ({
  ensureDaytonaWorkspace,
}));

vi.mock("./app-server-boot", () => ({
  formatStartError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  installDeps,
  startDevSession,
  stopDevSession,
}));

vi.mock("./runtime-observer", () => ({
  observeRuntime,
}));

import {
  ensureDesiredState,
  readRuntime,
} from "./runtime-reconciler";
import {
  getRuntimeSnapshot,
  withFreshIsolate,
} from "./runtime-store";
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

const fakeProject = {
  id: "proj",
  sdkSandbox: { id: "sb_1", delete: vi.fn() },
  process: { executeCommand: vi.fn() },
};

describe("runtime-reconciler isolate / UI races", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createSandbox.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { id: "sb_1", state: "started" };
    });
    reconnectSandbox.mockResolvedValue({ id: "sb_1", state: "started" });
    wrapSandbox.mockReturnValue(fakeProject);
    ensureDaytonaWorkspace.mockResolvedValue({ seeded: false });
    installDeps.mockResolvedValue(undefined);
    startDevSession.mockResolvedValue({
      sessionName: "preview-sess",
      port: 3000,
    });
    stopDevSession.mockResolvedValue(undefined);
    deleteSandboxById.mockResolvedValue(undefined);
    commitWorkspaceTurn.mockResolvedValue(undefined);
  });

  it("readRuntime never creates a sandbox (UI poll isolate)", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      ctx.sessionId = sessionId;
      observeRuntime.mockResolvedValue(observed({ phase: "missing" }));

      await withFreshIsolate(sessionId, () => readRuntime(sessionId));

      expect(createSandbox).not.toHaveBeenCalled();
      expect(installDeps).not.toHaveBeenCalled();
      expect(startDevSession).not.toHaveBeenCalled();
    });
  });

  it("two isolates racing ensure(preview-ready): only lease holder creates", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      ctx.sessionId = sessionId;

      let sandboxId: string | null = null;
      let hasPkg = false;
      let hasNode = false;
      let previewReady = false;
      let createEntered = 0;
      let releaseCreate: () => void = () => {};
      const createGate = new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });

      createSandbox.mockImplementation(async () => {
        createEntered += 1;
        await createGate;
        sandboxId = "sb_1";
        return { id: "sb_1", state: "started" };
      });

      ensureDaytonaWorkspace.mockImplementation(async () => {
        hasPkg = true;
        return { seeded: true, gitInitSha: "abc" };
      });
      installDeps.mockImplementation(async () => {
        hasNode = true;
      });
      startDevSession.mockImplementation(async () => {
        previewReady = true;
        return { sessionName: "preview-sess", port: 3000 };
      });

      observeRuntime.mockImplementation(async () => {
        if (!sandboxId) {
          return observed({ phase: "missing" });
        }
        if (!hasPkg) {
          return observed({
            phase: "bootstrapping-workspace",
            sandboxId,
            hasPackageJson: false,
          });
        }
        if (!hasNode) {
          return observed({
            phase: "workspace-ready",
            sandboxId,
            hasPackageJson: true,
            hasNodeModules: false,
          });
        }
        if (!previewReady) {
          return observed({
            phase: "workspace-ready",
            sandboxId,
            hasPackageJson: true,
            hasNodeModules: true,
          });
        }
        return observed({
          phase: "preview-ready",
          sandboxId,
          hasPackageJson: true,
          hasNodeModules: true,
          previewUrl: "https://embed.example/x",
          previewPort: 3000,
          previewExpiresAtMs: Date.now() + 60_000,
        });
      });

      const aPromise = withFreshIsolate(sessionId, () =>
        ensureDesiredState(sessionId, "preview-ready", {
          wait: true,
          owner: "isolate-A",
        }),
      );

      await vi.waitFor(() => {
        expect(createEntered).toBe(1);
      });

      // Second isolate starts while first holds lease inside createSandbox.
      const bPromise = withFreshIsolate(sessionId, () =>
        ensureDesiredState(sessionId, "preview-ready", {
          wait: true,
          owner: "isolate-B",
        }),
      );

      // While A is gated, B must not also create.
      await new Promise((r) => setTimeout(r, 80));
      expect(createEntered).toBe(1);

      releaseCreate();
      const [a, b] = await Promise.all([aPromise, bPromise]);

      expect(createEntered).toBe(1);
      expect(a.desired).toBe("preview-ready");
      expect(b.desired).toBe("preview-ready");

      enterIsolate(sessionId);
      const final = await getRuntimeSnapshot(sessionId, null, { fresh: true });
      expect(final.observed).toBe("preview-ready");
      expect(final.sandboxId).toBe("sb_1");
    });
  });

  it("UI stop generation beats in-flight start desired", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      ctx.sessionId = sessionId;

      let previewReady = false;
      stopDevSession.mockImplementation(async () => {
        previewReady = false;
      });

      observeRuntime.mockImplementation(async () => {
        if (previewReady) {
          return observed({
            phase: "preview-ready",
            sandboxId: "sb_1",
            hasPackageJson: true,
            hasNodeModules: true,
            previewUrl: "https://embed.example/x",
            previewPort: 3000,
            previewExpiresAtMs: Date.now() + 60_000,
          });
        }
        return observed({
          phase: "workspace-ready",
          sandboxId: "sb_1",
          hasPackageJson: true,
          hasNodeModules: true,
        });
      });

      // Simulate agent isolate mid-start (dev already up).
      const { upsertRuntimeSnapshot } = await import("./runtime-store");
      previewReady = true;
      await withFreshIsolate(sessionId, () =>
        upsertRuntimeSnapshot(sessionId, {
          desired: "preview-ready",
          observed: "preview-ready",
          sandboxId: "sb_1",
          generation: 1,
          devSessionName: "preview-sess",
          previewUrl: "https://embed.example/x",
          previewPort: 3000,
          previewExpiresAtMs: Date.now() + 60_000,
        }),
      );

      const stopSnap = await withFreshIsolate(sessionId, () =>
        ensureDesiredState(sessionId, "stopped", {
          wait: true,
          owner: "ui-isolate",
        }),
      );

      enterIsolate(sessionId);
      const final = await getRuntimeSnapshot(sessionId, null, { fresh: true });
      expect(final.desired).toBe("stopped");
      expect(final.generation).toBeGreaterThanOrEqual(2);
      expect(stopSnap.desired).toBe("stopped");
      expect(final.observed).toBe("workspace-ready");
      expect(final.previewUrl).toBeNull();
      expect(stopDevSession).toHaveBeenCalled();
    });
  });

  it("reconcile loop honors desired flip to stopped before finishing start", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      ctx.sessionId = sessionId;

      let sandboxId: string | null = null;
      let releaseCreate: () => void = () => {};
      const createGate = new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });

      createSandbox.mockImplementation(async () => {
        sandboxId = "sb_1";
        // Flip desired while create is in-flight (UI stop from another isolate).
        await withFreshIsolate(sessionId, async () => {
          const { upsertRuntimeSnapshot } = await import("./runtime-store");
          const cur = await getRuntimeSnapshot(sessionId, null, { fresh: true });
          await upsertRuntimeSnapshot(sessionId, {
            expectedRevision: cur.revision,
            desired: "stopped",
            generation: cur.generation + 1,
          });
        });
        await createGate;
        return { id: "sb_1", state: "started" };
      });

      observeRuntime.mockImplementation(async () => {
        if (!sandboxId) {
          return observed({ phase: "missing" });
        }
        return observed({
          phase: "workspace-ready",
          sandboxId,
          hasPackageJson: true,
          hasNodeModules: true,
        });
      });

      const startPromise = withFreshIsolate(sessionId, () =>
        ensureDesiredState(sessionId, "preview-ready", {
          wait: true,
          owner: "agent-isolate",
        }),
      );

      await vi.waitFor(() => {
        expect(createSandbox).toHaveBeenCalled();
      });
      releaseCreate();

      const result = await startPromise;
      expect(result.desired).toBe("stopped");
      expect(result.observed).not.toBe("preview-ready");
      expect(startDevSession).not.toHaveBeenCalled();
    });
  });

  it("restart bumps generation and clears preview cache flag path", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      ctx.sessionId = sessionId;

      observeRuntime.mockResolvedValue(
        observed({
          phase: "preview-ready",
          sandboxId: "sb_1",
          hasPackageJson: true,
          hasNodeModules: true,
          previewUrl: "https://old.example",
          previewPort: 3000,
          previewExpiresAtMs: Date.now() + 60_000,
        }),
      );

      // Seed ready state
      await withFreshIsolate(sessionId, async () => {
        const { upsertRuntimeSnapshot } = await import("./runtime-store");
        await upsertRuntimeSnapshot(sessionId, {
          desired: "preview-ready",
          observed: "preview-ready",
          sandboxId: "sb_1",
          previewUrl: "https://old.example",
          previewPort: 3000,
          previewExpiresAtMs: Date.now() + 60_000,
          generation: 3,
        });
      });

      let cleared = false;
      fakeProject.process.executeCommand.mockImplementation(async (cmd: string) => {
        if (cmd.includes(".next")) {
          cleared = true;
        }
        return { exitCode: 0 };
      });

      startDevSession.mockImplementation(async () => {
        return { sessionName: "preview-sess", port: 3000 };
      });

      // Observer may omit URL while probing; reconciler must keep the public preview URL.
      observeRuntime.mockImplementation(async () =>
        observed({
          phase: "preview-ready",
          sandboxId: "sb_1",
          hasPackageJson: true,
          hasNodeModules: true,
          previewUrl: null,
          previewPort: 3000,
          previewExpiresAtMs: null,
        }),
      );

      const snap = await withFreshIsolate(sessionId, () =>
        ensureDesiredState(sessionId, "preview-ready", {
          wait: true,
          restart: true,
          owner: "ui-restart",
        }),
      );

      expect(snap.generation).toBe(4);
      expect(cleared).toBe(true);
      expect(startDevSession).toHaveBeenCalled();
      // After restart reconcile, preview should be ready again with same URL
      expect(snap.observed).toBe("preview-ready");
      expect(snap.previewUrl).toBe("https://old.example");
    });
  });

  it("fire-and-forget startPreview writes desired without blocking", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      ctx.sessionId = sessionId;
      observeRuntime.mockResolvedValue(observed({ phase: "missing" }));

      let resolveCreate: (value: { id: string; state: string }) => void =
        () => {};
      createSandbox.mockImplementation(
        () =>
          new Promise<{ id: string; state: string }>((resolve) => {
            resolveCreate = resolve;
          }),
      );

      const started = Date.now();
      const snap = await withFreshIsolate(sessionId, () =>
        ensureDesiredState(sessionId, "preview-ready", {
          wait: false,
          owner: "agent-warmup",
        }),
      );
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(500);
      expect(snap.desired).toBe("preview-ready");

      // Unblock background reconcile so the test process can exit cleanly.
      resolveCreate({ id: "sb_1", state: "started" });
      await new Promise((r) => setTimeout(r, 50));
    });
  });
});
