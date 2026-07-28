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
  sandboxRecordExists,
  wrapSandbox,
  startDevSession,
  stopDevSession,
  observeRuntime,
  httpStatus,
} = vi.hoisted(() => {
  const ctx = { sessionId: "" };
  return {
    ctx,
    createSandbox: vi.fn(),
    deleteSandboxById: vi.fn(),
    reconnectSandbox: vi.fn(),
    sandboxRecordExists: vi.fn(async () => true),
    wrapSandbox: vi.fn(),
    startDevSession: vi.fn(),
    stopDevSession: vi.fn(),
    observeRuntime: vi.fn(),
    httpStatus: vi.fn(async () => 200),
  };
});

vi.mock("@/lib/session/store", () => ({
  getSession: vi.fn(async (id: string) =>
    id === ctx.sessionId ? makeSession(id) : null,
  ),
  updateSession: vi.fn(async () => makeSession(ctx.sessionId)),
}));

vi.mock("./vm", () => ({
  createSandbox,
  deleteSandboxById,
  reconnectSandbox,
  sandboxRecordExists,
  wrapSandbox,
  isAsleep: (state: string | undefined) =>
    state === "stopped" || state === "archived",
}));

vi.mock("./app-server-boot", () => ({
  formatStartError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  startDevSession,
  stopDevSession,
}));

vi.mock("./app-server-health", () => ({
  httpStatus,
  PREVIEW_HTTP_TIMEOUT_MS: 1_500,
}));

vi.mock("./runtime-observer", () => ({
  observeRuntime,
}));

import {
  ensureDesiredState,
  readRuntime,
} from "./runtime-reconciler";
import { isDesiredSatisfied } from "./runtime-state";
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
    startDevSession.mockResolvedValue({
      sessionName: "preview-sess",
      port: 3000,
    });
    stopDevSession.mockResolvedValue(undefined);
    deleteSandboxById.mockResolvedValue(undefined);
    sandboxRecordExists.mockResolvedValue(true);
    httpStatus.mockResolvedValue(200);
  });

  it("readRuntime never creates a sandbox (UI poll isolate)", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      ctx.sessionId = sessionId;
      observeRuntime.mockResolvedValue(observed({ phase: "missing" }));

      await withFreshIsolate(sessionId, () => readRuntime(sessionId));

      expect(createSandbox).not.toHaveBeenCalled();
      expect(startDevSession).not.toHaveBeenCalled();
    });
  });

  it("readRuntime preserves ready state after an inconclusive miss", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      ctx.sessionId = sessionId;
      const { upsertRuntimeSnapshot } = await import("./runtime-store");
      await upsertRuntimeSnapshot(sessionId, {
        desired: "preview-ready",
        observed: "preview-ready",
        sandboxId: "sb_1",
        previewUrl: "https://embed.example/x",
        previewPort: 3000,
      });
      observeRuntime.mockResolvedValue(
        observed({
          phase: "missing",
          lastError: "preview probe failed",
          transient: true,
        }),
      );

      const result = await withFreshIsolate(sessionId, () =>
        readRuntime(sessionId),
      );

      expect(result.observed).toBe("preview-ready");
      expect(result.previewUrl).toBe("https://embed.example/x");
    });
  });

  it("readRuntime applies a conclusive unhealthy observation", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      ctx.sessionId = sessionId;
      const { upsertRuntimeSnapshot } = await import("./runtime-store");
      await upsertRuntimeSnapshot(sessionId, {
        desired: "preview-ready",
        observed: "preview-ready",
        sandboxId: "sb_1",
        previewUrl: "https://embed.example/x",
        previewPort: 3000,
      });
      observeRuntime.mockResolvedValue(
        observed({
          phase: "workspace-ready",
          sandboxId: "sb_1",
          previewUrl: "https://embed.example/x",
          previewPort: 3000,
          httpStatus: 502,
          transient: false,
        }),
      );

      const result = await withFreshIsolate(sessionId, () =>
        readRuntime(sessionId),
      );

      expect(result.observed).toBe("workspace-ready");
      expect(result.previewUrl).toBe("https://embed.example/x");
    });
  });

  it("two isolates racing ensure(preview-ready): only lease holder creates", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      ctx.sessionId = sessionId;

      let sandboxId: string | null = null;
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
      startDevSession.mockImplementation(async () => {
        previewReady = true;
        return { sessionName: "preview-sess", port: 3000 };
      });

      observeRuntime.mockImplementation(async () => {
        if (!sandboxId) {
          return observed({ phase: "missing" });
        }
        if (!previewReady) {
          return observed({
            phase: "workspace-ready",
            sandboxId,
          });
        }
        return observed({
          phase: "preview-ready",
          sandboxId,
          previewUrl: "https://embed.example/x",
          previewPort: 3000,
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

  it("FS attach returns once sandbox exists (no seed)", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      ctx.sessionId = sessionId;

      let sandboxId: string | null = null;

      createSandbox.mockImplementation(async () => {
        sandboxId = "sb_snap";
        return { id: "sb_snap", state: "started" };
      });
      startDevSession.mockImplementation(async () => ({
        sessionName: "preview-sess",
        port: 3000,
      }));

      observeRuntime.mockImplementation(async () => {
        if (!sandboxId) {
          return observed({ phase: "missing" });
        }
        return observed({
          phase: "workspace-ready",
          sandboxId,
        });
      });

      const { upsertRuntimeSnapshot } = await import("./runtime-store");
      await withFreshIsolate(sessionId, () =>
        upsertRuntimeSnapshot(sessionId, {
          desired: "preview-ready",
          observed: "missing",
          generation: 1,
        }),
      );

      const fsSnap = await withFreshIsolate(sessionId, () =>
        ensureDesiredState(sessionId, "sandbox-ready", {
          wait: true,
          owner: "agent-fs",
        }),
      );

      expect(
        isDesiredSatisfied({ ...fsSnap, desired: "sandbox-ready" }),
      ).toBe(true);
      expect(fsSnap.sandboxId).toBe("sb_snap");
    });
  });

  it("FS attach (sandbox-ready) returns before preview start finishes", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      ctx.sessionId = sessionId;

      let sandboxId: string | null = null;
      let previewReady = false;
      let startEntered = 0;
      let releaseStart: () => void = () => {};
      const startGate = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });

      createSandbox.mockImplementation(async () => {
        sandboxId = "sb_1";
        return { id: "sb_1", state: "started" };
      });
      startDevSession.mockImplementation(async () => {
        startEntered += 1;
        await startGate;
        previewReady = true;
        return { sessionName: "preview-sess", port: 3000 };
      });

      observeRuntime.mockImplementation(async () => {
        if (!sandboxId) {
          return observed({ phase: "missing" });
        }
        if (!previewReady) {
          return observed({
            phase: "workspace-ready",
            sandboxId,
          });
        }
        return observed({
          phase: "preview-ready",
          sandboxId,
          previewUrl: "https://embed.example/x",
          previewPort: 3000,
        });
      });

      // UI already wants preview-ready (durable intent) before agent FS attach.
      const { upsertRuntimeSnapshot } = await import("./runtime-store");
      await withFreshIsolate(sessionId, () =>
        upsertRuntimeSnapshot(sessionId, {
          desired: "preview-ready",
          observed: "missing",
          generation: 1,
        }),
      );

      const fsPromise = withFreshIsolate(sessionId, () =>
        ensureDesiredState(sessionId, "sandbox-ready", {
          wait: true,
          owner: "agent-fs",
        }),
      );

      const fsSnap = await fsPromise;

      expect(
        isDesiredSatisfied({ ...fsSnap, desired: "sandbox-ready" }),
      ).toBe(true);
      expect(fsSnap.desired).toBe("preview-ready");
      expect(previewReady).toBe(false);
      // Must not block the agent on next start.
      expect(startEntered).toBe(0);

      // Background continue should pick up preview warm after FS returns.
      await vi.waitFor(() => {
        expect(startEntered).toBe(1);
      });
      releaseStart();
      await vi.waitFor(async () => {
        enterIsolate(sessionId);
        const final = await getRuntimeSnapshot(sessionId, null, { fresh: true });
        expect(final.observed).toBe("preview-ready");
      });
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
            previewUrl: "https://embed.example/x",
            previewPort: 3000,
          });
        }
        return observed({
          phase: "workspace-ready",
          sandboxId: "sb_1",
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
          previewUrl: "https://old.example",
          previewPort: 3000,
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
          previewUrl: null,
          previewPort: 3000,
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

  it("keeps preview-ready durable state across a transient observe miss", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      ctx.sessionId = sessionId;

      await withFreshIsolate(sessionId, async () => {
        const { upsertRuntimeSnapshot } = await import("./runtime-store");
        await upsertRuntimeSnapshot(sessionId, {
          desired: "preview-ready",
          observed: "preview-ready",
          sandboxId: "sb_1",
          devSessionName: "preview-sess",
          previewUrl: null,
          previewPort: 3000,
          generation: 1,
        });
      });

      const observedPhases: string[] = [];
      observeRuntime.mockImplementation(
        async (
          _sessionId: string,
          options: { snapshot: { observed: string } },
        ) => {
          observedPhases.push(options.snapshot.observed);
          if (observedPhases.length === 1) {
            return observed({
              phase: "missing",
              lastError: "preview probe failed",
              transient: true,
            });
          }
          return observed({
            phase: "preview-ready",
            sandboxId: "sb_1",
            previewUrl: "https://embed.example/x",
            previewPort: 3000,
            httpStatus: 200,
          });
        },
      );

      const result = await withFreshIsolate(sessionId, () =>
        ensureDesiredState(sessionId, "preview-ready", {
          wait: true,
          owner: "transient-observe",
        }),
      );

      expect(observedPhases).toEqual(["preview-ready", "preview-ready"]);
      expect(result.observed).toBe("preview-ready");
      expect(result.previewUrl).toBe("https://embed.example/x");
      expect(startDevSession).not.toHaveBeenCalled();
    });
  });

  it("honors a desired stop written during a transient observe", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      ctx.sessionId = sessionId;
      await withFreshIsolate(sessionId, async () => {
        const { upsertRuntimeSnapshot } = await import("./runtime-store");
        await upsertRuntimeSnapshot(sessionId, {
          desired: "preview-ready",
          observed: "preview-ready",
          sandboxId: "sb_1",
          devSessionName: "preview-sess",
          previewUrl: null,
          previewPort: 3000,
          generation: 1,
        });
      });

      observeRuntime
        .mockImplementationOnce(async () => {
          await withFreshIsolate(sessionId, async () => {
            const { upsertRuntimeSnapshot } = await import("./runtime-store");
            const current = await getRuntimeSnapshot(sessionId, null, {
              fresh: true,
            });
            await upsertRuntimeSnapshot(sessionId, {
              expectedRevision: current.revision,
              desired: "stopped",
              generation: current.generation + 1,
            });
          });
          return observed({
            phase: "missing",
            lastError: "observe timeout",
            transient: true,
          });
        })
        .mockResolvedValue(
          observed({
            phase: "workspace-ready",
            sandboxId: "sb_1",
          }),
        );

      const result = await withFreshIsolate(sessionId, () =>
        ensureDesiredState(sessionId, "preview-ready", {
          wait: true,
          owner: "transient-desired-flip",
        }),
      );

      expect(result.desired).toBe("stopped");
      expect(result.observed).toBe("workspace-ready");
      expect(stopDevSession).toHaveBeenCalled();
      expect(startDevSession).not.toHaveBeenCalled();
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

  it("wait=false kick=false only persists desired (no create)", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      ctx.sessionId = sessionId;
      observeRuntime.mockResolvedValue(observed({ phase: "missing" }));

      const snap = await withFreshIsolate(sessionId, () =>
        ensureDesiredState(sessionId, "preview-ready", {
          wait: false,
          kick: false,
          owner: "warm-intent",
        }),
      );

      expect(snap.desired).toBe("preview-ready");
      expect(createSandbox).not.toHaveBeenCalled();
      await new Promise((r) => setTimeout(r, 30));
      expect(createSandbox).not.toHaveBeenCalled();
    });
  });

  it("parallel create from two owners: only one sandboxId persists", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      ctx.sessionId = sessionId;

      let createCount = 0;
      let sandboxId: string | null = null;
      let previewReady = false;

      createSandbox.mockImplementation(async () => {
        createCount += 1;
        const id = `sb_${createCount}`;
        await new Promise((r) => setTimeout(r, 40));
        sandboxId = id;
        return { id, state: "started" };
      });
      startDevSession.mockImplementation(async () => {
        previewReady = true;
        return { sessionName: "preview-sess", port: 3000 };
      });

      observeRuntime.mockImplementation(async () => {
        if (!sandboxId) {
          return observed({ phase: "missing" });
        }
        if (!previewReady) {
          return observed({
            phase: "workspace-ready",
            sandboxId,
          });
        }
        return observed({
          phase: "preview-ready",
          sandboxId,
          previewUrl: "https://embed.example/x",
          previewPort: 3000,
        });
      });

      const [a, b] = await Promise.all([
        withFreshIsolate(sessionId, () =>
          ensureDesiredState(sessionId, "preview-ready", {
            wait: true,
            owner: "warm-aaaa",
          }),
        ),
        withFreshIsolate(sessionId, () =>
          ensureDesiredState(sessionId, "preview-ready", {
            wait: true,
            owner: "warm-bbbb",
          }),
        ),
      ]);

      expect(createCount).toBe(1);
      expect(a.sandboxId).toBeTruthy();
      expect(b.sandboxId).toBe(a.sandboxId);
      expect(a.observed).toBe("preview-ready");
      expect(deleteSandboxById).not.toHaveBeenCalled();
    });
  });

  it("readRuntime clears stale sandboxId when console-deleted (confirmedAbsent)", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      ctx.sessionId = sessionId;
      const { upsertRuntimeSnapshot } = await import("./runtime-store");
      await upsertRuntimeSnapshot(sessionId, {
        desired: "preview-ready",
        observed: "preview-ready",
        sandboxId: "sb_dead",
        previewUrl: "https://embed.example/x",
        previewPort: 3000,
        generation: 2,
      });
      observeRuntime.mockResolvedValue(
        observed({
          phase: "missing",
          confirmedAbsent: true,
          lastError: "Daytona sandbox deleted externally (not found)",
        }),
      );

      const result = await withFreshIsolate(sessionId, () =>
        readRuntime(sessionId),
      );

      expect(result.sandboxId).toBeNull();
      expect(result.observed).toBe("missing");
      expect(result.previewUrl).toBeNull();
      expect(result.generation).toBe(3);
      expect(createSandbox).not.toHaveBeenCalled();
    });
  });

  it("ensureDesired recreates sandbox after confirmedAbsent (console delete)", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      ctx.sessionId = sessionId;
      const { upsertRuntimeSnapshot } = await import("./runtime-store");
      await upsertRuntimeSnapshot(sessionId, {
        desired: "preview-ready",
        observed: "preview-ready",
        sandboxId: "sb_dead",
        previewUrl: "https://embed.example/old",
        previewPort: 3000,
        generation: 1,
      });

      sandboxRecordExists.mockImplementation(async (id: string) => id !== "sb_dead");

      let liveId: string | null = null;
      createSandbox.mockImplementation(async () => {
        liveId = "sb_new";
        return { id: "sb_new", state: "started" };
      });
      startDevSession.mockImplementation(async () => ({
        sessionName: "preview-sess",
        port: 3000,
      }));

      observeRuntime.mockImplementation(async (_sid, opts) => {
        const snap = opts?.snapshot ?? (await getRuntimeSnapshot(sessionId));
        if (snap.sandboxId === "sb_dead") {
          return observed({
            phase: "missing",
            confirmedAbsent: true,
            lastError: "Daytona sandbox deleted externally (not found)",
          });
        }
        if (!snap.sandboxId) {
          return observed({ phase: "missing" });
        }
        if (liveId && snap.sandboxId === liveId) {
          return observed({
            phase: "preview-ready",
            sandboxId: liveId,
            previewUrl: "https://embed.example/new",
            previewPort: 3000,
          });
        }
        return observed({
          phase: "workspace-ready",
          sandboxId: snap.sandboxId,
        });
      });

      const result = await withFreshIsolate(sessionId, () =>
        ensureDesiredState(sessionId, "preview-ready", {
          wait: true,
          owner: "console-delete-recover",
        }),
      );

      expect(createSandbox).toHaveBeenCalled();
      expect(result.sandboxId).toBe("sb_new");
      expect(result.observed).toBe("preview-ready");
      expect(result.generation).toBeGreaterThanOrEqual(2);
    });
  });

  it("ensureDesired restarts pnpm only when durable ready but probe is 502", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      ctx.sessionId = sessionId;
      const { upsertRuntimeSnapshot } = await import("./runtime-store");
      await upsertRuntimeSnapshot(sessionId, {
        desired: "preview-ready",
        observed: "preview-ready",
        sandboxId: "sb_live",
        previewUrl: "https://embed.example/stale",
        previewPort: 3000,
        devSessionName: "preview-old",
        generation: 1,
      });

      httpStatus.mockResolvedValueOnce(502);
      reconnectSandbox.mockResolvedValue({ id: "sb_live", state: "started" });
      wrapSandbox.mockImplementation((_sid: string, sdk: unknown) => ({
        sdkSandbox: {
          ...(sdk as object),
          getPreviewLink: async () => ({
            url: "https://embed.example/stale",
          }),
        },
        process: { executeCommand: vi.fn() },
      }));
      startDevSession.mockResolvedValue({
        sessionName: "preview-new",
        port: 3000,
      });

      let started = false;
      observeRuntime.mockImplementation(async (_sid, opts) => {
        const snap = opts?.snapshot ?? (await getRuntimeSnapshot(sessionId));
        if (started || snap.devSessionName === "preview-new") {
          return observed({
            phase: "preview-ready",
            sandboxId: "sb_live",
            previewUrl: "https://embed.example/stale",
            previewPort: 3000,
            httpStatus: 200,
          });
        }
        return observed({
          phase: "workspace-ready",
          sandboxId: "sb_live",
          previewUrl: "https://embed.example/stale",
          previewPort: 3000,
          httpStatus: 502,
        });
      });
      startDevSession.mockImplementation(async () => {
        started = true;
        return { sessionName: "preview-new", port: 3000 };
      });

      const result = await withFreshIsolate(sessionId, () =>
        ensureDesiredState(sessionId, "preview-ready", {
          wait: true,
          owner: "stale-preview-recover",
        }),
      );

      expect(createSandbox).not.toHaveBeenCalled();
      expect(startDevSession).toHaveBeenCalled();
      expect(result.sandboxId).toBe("sb_live");
      expect(result.observed).toBe("preview-ready");
    });
  });

  it("ensureDesired trusts durable preview-ready when probe is healthy", async () => {
    await withTempDataDir(async ({ sessionId }) => {
      ctx.sessionId = sessionId;
      const { upsertRuntimeSnapshot } = await import("./runtime-store");
      await upsertRuntimeSnapshot(sessionId, {
        desired: "preview-ready",
        observed: "preview-ready",
        sandboxId: "sb_live",
        previewUrl: "https://embed.example/ok",
        previewPort: 3000,
        generation: 1,
      });

      httpStatus.mockResolvedValue(200);

      const result = await withFreshIsolate(sessionId, () =>
        ensureDesiredState(sessionId, "preview-ready", {
          wait: true,
          owner: "healthy-preview",
        }),
      );

      expect(httpStatus).toHaveBeenCalled();
      expect(createSandbox).not.toHaveBeenCalled();
      expect(startDevSession).not.toHaveBeenCalled();
      expect(result.observed).toBe("preview-ready");
    });
  });
});
