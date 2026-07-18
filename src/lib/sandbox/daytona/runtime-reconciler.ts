/**
 * Daytona runtime reconciler — single writer that converges observed → desired.
 */

import { randomUUID } from "node:crypto";

import { getSession, updateSession } from "@/lib/session/store";
import { commitWorkspaceTurn } from "../workspace-git";

import {
  formatStartError,
  installDeps,
  startDevSession,
  stopDevSession,
} from "./app-server-boot";
import { extractCompileError, httpStatus, readDevLog } from "./app-server-health";
import { logDaytonaBootstrap } from "./bootstrap-log";
import { getDaytonaDevPort } from "./config";
import type { DaytonaProjectSandbox } from "./provider";
import {
  observeRuntime,
  type ObservedRuntime,
} from "./runtime-observer";
import {
  deriveAllStatus,
  deriveAppServerStatus,
  hasFreshPreviewEmbed,
  isDesiredSatisfied,
  type DaytonaDesiredState,
  type DaytonaRuntimeSnapshot,
} from "./runtime-state";
import {
  acquireRuntimeLease,
  clearRuntimeSnapshot,
  getRuntimeSnapshot,
  releaseRuntimeLease,
  renewRuntimeLease,
  upsertRuntimeSnapshot,
} from "./runtime-store";
import { ensureDaytonaWorkspace } from "./workspace-bootstrap";
import {
  createSandbox,
  deleteSandboxById,
  reconnectSandbox,
  wrapSandbox,
} from "./vm";

const LEASE_TTL_MS = 45_000;
const RECONCILE_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 2_000;

export interface EnsureDesiredOptions {
  wait?: boolean;
  owner?: string;
  /** Bump generation and request .next clear (restart). */
  restart?: boolean;
}

function applyObservation(
  snapshot: DaytonaRuntimeSnapshot,
  observed: ObservedRuntime,
): Partial<DaytonaRuntimeSnapshot> {
  const controllerPhases = new Set<string>([
    "creating-sandbox",
    "bootstrapping-workspace",
    "installing-deps",
    "starting-devserver",
    "stopping",
    "deleting",
  ]);

  let phase = observed.phase;

  if (snapshot.observed === "installing-deps" && observed.hasNodeModules) {
    phase = "workspace-ready";
  } else if (
    snapshot.observed === "starting-devserver" &&
    observed.phase === "preview-ready"
  ) {
    phase = "preview-ready";
  } else if (
    controllerPhases.has(snapshot.observed) &&
    snapshot.observed !== "error" &&
    observed.phase !== "preview-ready" &&
    observed.phase !== "missing"
  ) {
    // Keep transitional controller phase while action is in flight.
    phase = snapshot.observed;
  }

  // Keep public preview URL across Next restarts (same sandbox + port;
  // process down is just 502). Only drop when the sandbox itself is gone.
  const sandboxGone =
    phase === "missing" && !(observed.sandboxId ?? snapshot.sandboxId);

  return {
    observed: phase,
    sandboxId: observed.sandboxId ?? snapshot.sandboxId,
    previewUrl: observed.previewUrl ?? (sandboxGone ? null : snapshot.previewUrl),
    previewPort:
      observed.previewPort ?? (sandboxGone ? null : snapshot.previewPort),
    lastError:
      observed.lastError ?? (phase === "error" ? snapshot.lastError : null),
    lastObservedAt: new Date().toISOString(),
  };
}

/** Observe timeout / empty failure — must not clobber a known-good snapshot. */
function isTransientObserveFailure(observed: ObservedRuntime): boolean {
  if (observed.phase === "preview-ready") {
    return false;
  }
  if (!observed.lastError) {
    return false;
  }
  const detail = observed.lastError.toLowerCase();
  return (
    detail.includes("timeout") ||
    detail.includes("observe failed") ||
    (observed.phase === "missing" && !observed.sandboxId)
  );
}

function shouldPreserveSnapshotOnObserveMiss(
  observed: ObservedRuntime,
  snapshot: DaytonaRuntimeSnapshot,
): boolean {
  if (!isTransientObserveFailure(observed)) {
    return false;
  }
  return (
    snapshot.observed === "preview-ready" ||
    snapshot.observed === "starting-devserver" ||
    snapshot.observed === "installing-deps" ||
    snapshot.observed === "workspace-ready" ||
    snapshot.desired === "preview-ready" ||
    hasFreshPreviewEmbed(snapshot)
  );
}

async function attachProject(
  sessionId: string,
  sandboxId: string,
  wake: boolean,
): Promise<DaytonaProjectSandbox | null> {
  const sdk = await reconnectSandbox(sessionId, sandboxId, wake);
  if (!sdk) {
    return null;
  }
  return wrapSandbox(sessionId, sdk);
}

async function upsertWithRetry(
  sessionId: string,
  patch: Omit<Parameters<typeof upsertRuntimeSnapshot>[1], "expectedRevision">,
  attempts = 8,
): Promise<DaytonaRuntimeSnapshot> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    const current = await getRuntimeSnapshot(sessionId, null, { fresh: true });
    try {
      return await upsertRuntimeSnapshot(sessionId, {
        ...patch,
        expectedRevision: current.revision,
      });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/CAS conflict/i.test(message)) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? "CAS retry exhausted"));
}

async function actionCreateSandbox(
  sessionId: string,
  snapshot: DaytonaRuntimeSnapshot,
): Promise<void> {
  if (snapshot.sandboxId) {
    return;
  }

  const session = await getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  await upsertWithRetry(sessionId, {
    observed: "creating-sandbox",
    lastError: null,
  });

  // Re-check after claiming the creating phase — another isolate may have created.
  const latest = await getRuntimeSnapshot(sessionId, null, { fresh: true });
  if (latest.sandboxId) {
    return;
  }

  const sdk = await createSandbox(session);
  await upsertWithRetry(sessionId, {
    sandboxId: sdk.id,
    observed: "bootstrapping-workspace",
  });
}

async function actionBootstrapWorkspace(
  sessionId: string,
  snapshot: DaytonaRuntimeSnapshot,
): Promise<void> {
  if (!snapshot.sandboxId) {
    return;
  }

  const session = await getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const project = await attachProject(sessionId, snapshot.sandboxId, true);
  if (!project) {
    await upsertWithRetry(sessionId, {
      sandboxId: null,
      observed: "missing",
    });
    return;
  }

  await upsertWithRetry(sessionId, {
    observed: "bootstrapping-workspace",
  });

  const result = await ensureDaytonaWorkspace(project, session);
  if (result.gitInitSha) {
    await updateSession(sessionId, { lastCommitSha: result.gitInitSha });
  }

  await upsertWithRetry(sessionId, {
    observed: "workspace-ready",
  });
}

async function actionInstallDeps(
  sessionId: string,
  snapshot: DaytonaRuntimeSnapshot,
): Promise<void> {
  if (!snapshot.sandboxId) {
    return;
  }
  const project = await attachProject(sessionId, snapshot.sandboxId, true);
  if (!project) {
    return;
  }

  await upsertWithRetry(sessionId, {
    observed: "installing-deps",
  });

  await installDeps(project, sessionId);

  await upsertWithRetry(sessionId, {
    observed: "workspace-ready",
  });
}

async function actionStartDev(
  sessionId: string,
  snapshot: DaytonaRuntimeSnapshot,
): Promise<void> {
  if (!snapshot.sandboxId) {
    return;
  }
  const project = await attachProject(sessionId, snapshot.sandboxId, true);
  if (!project) {
    return;
  }

  if (snapshot.clearNextCache) {
    try {
      await project.process.executeCommand("rm -rf .next", ".", undefined, 60);
    } catch {
      // best effort
    }
  }

  await upsertWithRetry(sessionId, {
    observed: "starting-devserver",
    clearNextCache: false,
    // Keep public previewUrl — same sandbox/port; Next down is 502 only.
  });

  const started = await startDevSession(project, sessionId);
  await upsertWithRetry(sessionId, {
    observed: "starting-devserver",
    devSessionName: started.sessionName,
    previewPort: started.port,
  });
}

async function actionStopPreview(
  sessionId: string,
  snapshot: DaytonaRuntimeSnapshot,
): Promise<void> {
  await upsertWithRetry(sessionId, {
    observed: "stopping",
  });

  const latest = await getRuntimeSnapshot(sessionId, null, { fresh: true });
  const sandboxId = latest.sandboxId ?? snapshot.sandboxId;
  const project = sandboxId
    ? await attachProject(sessionId, sandboxId, false)
    : null;
  await stopDevSession(project, sessionId);

  await upsertWithRetry(sessionId, {
    observed: sandboxId ? "workspace-ready" : "missing",
    devSessionName: null,
    previewUrl: null,
    previewPort: null,
    lastError: null,
  });
}

async function actionDelete(
  sessionId: string,
  snapshot: DaytonaRuntimeSnapshot,
): Promise<void> {
  await upsertWithRetry(sessionId, {
    observed: "deleting",
  });

  const latest = await getRuntimeSnapshot(sessionId, null, { fresh: true });
  const sandboxId = latest.sandboxId ?? snapshot.sandboxId;

  if (sandboxId) {
    const project = await attachProject(sessionId, sandboxId, true);
    if (project) {
      await stopDevSession(project, sessionId);
      try {
        await commitWorkspaceTurn(project, {
          turnIndex: 0,
          userPrompt: "",
          messageOverride: "checkpoint: sandbox destroy",
        });
      } catch {
        // best-effort
      }
      try {
        await project.sdkSandbox.delete(60);
      } catch {
        // already gone
      }
    } else {
      await deleteSandboxById(sessionId, sandboxId);
    }
  }

  await clearRuntimeSnapshot(sessionId);
  // Re-seed empty deleted state.
  await upsertRuntimeSnapshot(sessionId, {
    expectedRevision: 0,
    desired: "deleted",
    observed: "missing",
    sandboxId: null,
    devSessionName: null,
    previewUrl: null,
    previewPort: null,
    lastError: null,
    generation: snapshot.generation,
    clearNextCache: false,
  });
}

/**
 * Pick exactly one action to move closer to desired.
 * Returns true if an action was started / completed this tick.
 */
async function reconcileOnce(
  sessionId: string,
  snapshot: DaytonaRuntimeSnapshot,
  observed: ObservedRuntime,
): Promise<boolean> {
  const desired = snapshot.desired;

  if (desired === "deleted") {
    if (snapshot.sandboxId || snapshot.observed !== "missing") {
      await actionDelete(sessionId, snapshot);
      return true;
    }
    return false;
  }

  if (desired === "stopped") {
    const needsStop =
      snapshot.observed === "preview-ready" ||
      snapshot.observed === "starting-devserver" ||
      snapshot.observed === "installing-deps" ||
      snapshot.observed === "creating-sandbox" ||
      snapshot.observed === "bootstrapping-workspace" ||
      Boolean(snapshot.devSessionName) ||
      Boolean(snapshot.previewUrl);

    if (needsStop) {
      await actionStopPreview(sessionId, snapshot);
      return true;
    }
    return false;
  }

  // sandbox-ready or preview-ready both need a live workspace.
  const latest = await getRuntimeSnapshot(sessionId, null, { fresh: true });
  if (latest.desired === "stopped" || latest.desired === "deleted") {
    // Desired flipped under us — let the next loop iteration handle it.
    return true;
  }

  if (!latest.sandboxId || observed.phase === "missing") {
    await actionCreateSandbox(sessionId, latest);
    return true;
  }

  if (
    observed.phase === "bootstrapping-workspace" ||
    !observed.hasPackageJson ||
    snapshot.observed === "creating-sandbox"
  ) {
    await actionBootstrapWorkspace(sessionId, snapshot);
    return true;
  }

  if (desired === "sandbox-ready") {
    return false;
  }

  // preview-ready
  if (!observed.hasNodeModules) {
    if (snapshot.observed === "installing-deps") {
      return false;
    }
    await actionInstallDeps(sessionId, snapshot);
    return true;
  }

  if (observed.phase === "preview-ready" && !snapshot.clearNextCache) {
    return false;
  }

  if (snapshot.observed !== "starting-devserver" || snapshot.clearNextCache) {
    await actionStartDev(sessionId, snapshot);
    return true;
  }

  // starting-devserver: wait for observer
  return false;
}

async function reconcileLoop(
  sessionId: string,
  owner: string,
  deadline: number,
  /**
   * Caller wait target. FS attach asks for sandbox-ready even when durable
   * desired stays preview-ready — return as soon as workspace is usable, do
   * not block on pnpm install / next dev.
   */
  returnWhen: DaytonaDesiredState,
): Promise<DaytonaRuntimeSnapshot> {
  while (Date.now() < deadline) {
    await renewRuntimeLease(sessionId, owner, LEASE_TTL_MS);

    // Always reload durable state — another isolate may have flipped desired.
    let snapshot = await getRuntimeSnapshot(sessionId, null, { fresh: true });

    // If desired flipped to stopped/deleted mid-flight, prefer that over finishing start.
    if (
      (snapshot.desired === "stopped" || snapshot.desired === "deleted") &&
      snapshot.observed !== "stopping" &&
      snapshot.observed !== "deleting"
    ) {
      // fall through to observe + reconcileOnce for stop/delete
    }

    const observed = await observeRuntime(sessionId, {
      wake:
        snapshot.desired === "sandbox-ready" ||
        snapshot.desired === "preview-ready" ||
        snapshot.desired === "deleted",
      snapshot,
    });

    const obsPatch = applyObservation(snapshot, observed);
    try {
      snapshot = await upsertRuntimeSnapshot(sessionId, {
        expectedRevision: snapshot.revision,
        ...obsPatch,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/CAS conflict/i.test(message)) {
        throw error;
      }
      // Another isolate updated — reload and continue.
      snapshot = await getRuntimeSnapshot(sessionId, null, { fresh: true });
      continue;
    }

    // Prefer caller's wait target (sandbox-ready) over durable preview-ready.
    if (isDesiredSatisfied({ ...snapshot, desired: returnWhen })) {
      return snapshot;
    }

    if (isDesiredSatisfied(snapshot)) {
      return snapshot;
    }

    if (snapshot.observed === "error" && snapshot.desired !== "deleted") {
      return snapshot;
    }

    const acted = await reconcileOnce(sessionId, snapshot, observed);
    if (!acted) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  const timedOut = await getRuntimeSnapshot(sessionId, null, { fresh: true });
  if (isDesiredSatisfied({ ...timedOut, desired: returnWhen })) {
    return timedOut;
  }
  if (!isDesiredSatisfied(timedOut)) {
    return upsertRuntimeSnapshot(sessionId, {
      expectedRevision: timedOut.revision,
      observed: "error",
      lastError:
        timedOut.lastError ??
        `Timed out reconciling to ${timedOut.desired}`,
    });
  }
  return timedOut;
}

/** Continue preview warm after FS attach returned early at sandbox-ready. */
function continuePreviewInBackground(sessionId: string): void {
  void ensureDesiredState(sessionId, "preview-ready", { wait: false }).catch(
    () => {
      // logged inside
    },
  );
}

/**
 * Submit desired state and optionally wait until converged.
 */
export async function ensureDesiredState(
  sessionId: string,
  desired: DaytonaDesiredState,
  options?: EnsureDesiredOptions,
): Promise<DaytonaRuntimeSnapshot> {
  const wait = options?.wait ?? true;
  const owner = options?.owner ?? randomUUID();

  const session = await getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  if (session.sandboxMode !== "daytona") {
    throw new Error(`Session ${sessionId} is not in daytona mode`);
  }

  let snapshot = await getRuntimeSnapshot(sessionId, null, { fresh: true });

  // What the caller needs vs what we write as durable desired.
  // FS attach requests sandbox-ready; UI warm may already have preview-ready —
  // never demote desired, but also never make FS wait for full preview boot.
  const requestedDesired = desired;
  let targetDesired: DaytonaDesiredState = desired;

  // Already have what the caller asked for (e.g. workspace ready while preview installs).
  if (
    !options?.restart &&
    isDesiredSatisfied({ ...snapshot, desired: requestedDesired }) &&
    (requestedDesired !== "preview-ready" || hasFreshPreviewEmbed(snapshot))
  ) {
    return snapshot;
  }

  // Never demote preview-ready → sandbox-ready (FS attach used to clobber warm).
  if (
    !options?.restart &&
    requestedDesired === "sandbox-ready" &&
    snapshot.desired === "preview-ready"
  ) {
    // Keep preview intent; converge under preview-ready instead.
    targetDesired = "preview-ready";
  }

  let intentGeneration = snapshot.generation + 1;
  const maxDesiredAttempts = 12;
  let submitted = false;
  for (let attempt = 0; attempt < maxDesiredAttempts; attempt++) {
    try {
      const patch: Parameters<typeof upsertRuntimeSnapshot>[1] = {
        expectedRevision: snapshot.revision,
        desired: targetDesired,
        generation: intentGeneration,
        lastError: null,
      };
      if (options?.restart) {
        // Force another startDev cycle; keep preview URL (port unchanged).
        patch.clearNextCache = true;
      }
      snapshot = await upsertRuntimeSnapshot(sessionId, patch);
      submitted = true;
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/CAS conflict/i.test(message) || attempt === maxDesiredAttempts - 1) {
        throw error;
      }
      snapshot = await getRuntimeSnapshot(sessionId, null, { fresh: true });
      if (
        snapshot.desired === targetDesired &&
        snapshot.generation >= intentGeneration
      ) {
        submitted = true;
        break;
      }
      // Another intent landed — claim a newer generation and retry.
      intentGeneration = snapshot.generation + 1;
    }
  }

  logDaytonaBootstrap(sessionId, "reconcile", `desired=${targetDesired}`, {
    generation: snapshot.generation,
    leaseOwner: owner,
  });

  const afterSandboxReadyForPreview = (
    result: DaytonaRuntimeSnapshot,
  ): void => {
    // Returned at sandbox-ready while durable desired is still preview-ready —
    // hand warm-up to a background writer (must run after lease release).
    if (
      requestedDesired === "sandbox-ready" &&
      result.desired === "preview-ready" &&
      !isDesiredSatisfied(result)
    ) {
      continuePreviewInBackground(sessionId);
    }
  };

  const runWithLease = async (
    deadline: number,
  ): Promise<DaytonaRuntimeSnapshot> => {
    let result: DaytonaRuntimeSnapshot;
    try {
      result = await reconcileLoop(
        sessionId,
        owner,
        deadline,
        requestedDesired,
      );
    } catch (error) {
      const detail = formatStartError(error);
      logDaytonaBootstrap(sessionId, "reconcile", `failed: ${detail.slice(0, 200)}`, {
        generation: snapshot.generation,
        leaseOwner: owner,
      });
      try {
        const cur = await getRuntimeSnapshot(sessionId, null, { fresh: true });
        result = await upsertRuntimeSnapshot(sessionId, {
          expectedRevision: cur.revision,
          observed: "error",
          lastError: detail,
        });
      } catch {
        result = await getRuntimeSnapshot(sessionId, null, { fresh: true });
      }
    } finally {
      await releaseRuntimeLease(sessionId, owner);
    }
    afterSandboxReadyForPreview(result);
    return result;
  };

  const run = async (): Promise<DaytonaRuntimeSnapshot> => {
    const leased = await acquireRuntimeLease(sessionId, owner, LEASE_TTL_MS);
    if (!leased) {
      // Another writer holds the lease — wait for convergence if requested.
      if (!wait) {
        return getRuntimeSnapshot(sessionId, null, { fresh: true });
      }
      const deadline = Date.now() + RECONCILE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const current = await getRuntimeSnapshot(sessionId, null, {
          fresh: true,
        });
        // Wait for what the caller asked for, not necessarily full preview-ready.
        if (isDesiredSatisfied({ ...current, desired: requestedDesired })) {
          return current;
        }
        // Try to steal expired lease
        const again = await acquireRuntimeLease(sessionId, owner, LEASE_TTL_MS);
        if (again) {
          return runWithLease(deadline);
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      return getRuntimeSnapshot(sessionId, null, { fresh: true });
    }

    return runWithLease(Date.now() + RECONCILE_TIMEOUT_MS);
  };

  if (!wait) {
    void run().catch(() => {
      // logged inside
    });
    return getRuntimeSnapshot(sessionId, null, { fresh: true });
  }

  return run();
}

/**
 * Durable snapshot only — no Daytona observe. Fast for UI poll / warm.
 */
export async function peekRuntimeAllStatus(sessionId: string) {
  const snapshot = await getRuntimeSnapshot(sessionId, null, { fresh: true });
  return deriveAllStatus(snapshot);
}

export async function peekRuntimeAppServerStatus(sessionId: string) {
  const snapshot = await getRuntimeSnapshot(sessionId, null, { fresh: true });
  return deriveAppServerStatus(snapshot);
}

/** Fire-and-forget soft observe to refresh durable snapshot. */
export function refreshRuntimeInBackground(sessionId: string): void {
  void readRuntime(sessionId).catch(() => {
    // best-effort
  });
}

/**
 * Soft observe without waking — updates durable snapshot.
 * Prefer peekRuntime* for UI; use this when status must be re-probed.
 *
 * Never clobber a known-good preview-ready snapshot with observe timeout /
 * empty failures (those were returning checkPreview=stopped while logs showed ready).
 */
export async function readRuntime(
  sessionId: string,
): Promise<DaytonaRuntimeSnapshot> {
  let snapshot = await getRuntimeSnapshot(sessionId);

  if (snapshot.desired === "deleted" && !snapshot.sandboxId) {
    return snapshot;
  }

  const observed = await observeRuntime(sessionId, {
    wake: false,
    snapshot,
  });

  if (shouldPreserveSnapshotOnObserveMiss(observed, snapshot)) {
    return snapshot;
  }

  try {
    snapshot = await upsertRuntimeSnapshot(sessionId, {
      expectedRevision: snapshot.revision,
      ...applyObservation(snapshot, observed),
      ...(observed.phase === "preview-ready"
        ? {
            previewUrl: observed.previewUrl,
            previewPort: observed.previewPort,
          }
        : {}),
    });
  } catch {
    snapshot = await getRuntimeSnapshot(sessionId);
  }

  return snapshot;
}

export async function readRuntimeAppServerStatus(sessionId: string) {
  return peekRuntimeAppServerStatus(sessionId);
}

export async function readRuntimeAllStatus(sessionId: string) {
  return peekRuntimeAllStatus(sessionId);
}

/**
 * Health check for the agent tool.
 *
 * Fast path (durable preview-ready + url): skip full observe; still require
 * compile log + HTTP < 500 (502 = Next/proxy not actually up).
 * Full observe when not ready / reconnect fails.
 */
export async function checkRuntimePreview(sessionId: string) {
  const snapshot = await getRuntimeSnapshot(sessionId, null, { fresh: true });

  if (hasFreshPreviewEmbed(snapshot) && snapshot.sandboxId && snapshot.previewUrl) {
    try {
      const sdk = await reconnectSandbox(sessionId, snapshot.sandboxId, false);
      if (sdk) {
        const project = wrapSandbox(sessionId, sdk);
        const [logText, probe] = await Promise.all([
          readDevLog(project),
          httpStatus(snapshot.previewUrl),
        ]);
        const buildError = extractCompileError(logText);

        // 502/5xx: durable said ready but proxy still unhealthy — keep waiting.
        if (probe >= 500) {
          return {
            status: "starting" as const,
            url: snapshot.previewUrl,
            buildError,
            httpStatus: probe,
          };
        }

        return {
          status: "ready" as const,
          url: snapshot.previewUrl,
          buildError,
          httpStatus: probe,
        };
      }
    } catch {
      // fall through to full observe
    }
  }

  const observed = await observeRuntime(sessionId, {
    wake: false,
    snapshot,
  });

  if (!shouldPreserveSnapshotOnObserveMiss(observed, snapshot)) {
    try {
      await upsertRuntimeSnapshot(sessionId, {
        expectedRevision: snapshot.revision,
        ...applyObservation(snapshot, observed),
        ...(observed.phase === "preview-ready"
          ? {
              previewUrl: observed.previewUrl,
              previewPort: observed.previewPort,
            }
          : {}),
      });
    } catch {
      // CAS — ignore; check result still uses live observe / peek
    }
  }

  // observeRuntime already probed HTTP + readDevLog when preview-ready.
  if (observed.phase === "preview-ready") {
    const url = observed.previewUrl ?? snapshot.previewUrl ?? undefined;
    const probe = observed.httpStatus ?? undefined;
    if (probe !== undefined && probe >= 500) {
      return {
        status: "starting" as const,
        url,
        buildError: observed.buildError,
        httpStatus: probe,
      };
    }
    return {
      status: "ready" as const,
      url,
      buildError: observed.buildError,
      httpStatus: probe,
    };
  }

  // Transient probe failure but durable says ready — re-probe HTTP before
  // claiming ready (undefined httpStatus must not count as ok).
  if (
    shouldPreserveSnapshotOnObserveMiss(observed, snapshot) &&
    hasFreshPreviewEmbed(snapshot) &&
    snapshot.previewUrl
  ) {
    const probe = await httpStatus(snapshot.previewUrl);
    if (probe >= 500) {
      return {
        status: "starting" as const,
        url: snapshot.previewUrl,
        buildError: null,
        httpStatus: probe,
      };
    }
    return {
      status: "ready" as const,
      url: snapshot.previewUrl,
      buildError: null,
      httpStatus: probe,
    };
  }

  const latest = await getRuntimeSnapshot(sessionId, null, { fresh: true });
  const app = deriveAppServerStatus(latest);

  return {
    status: app.status,
    url: app.status === "ready" ? app.url : undefined,
    buildError:
      app.status === "error"
        ? (app.error ?? "Preview failed to start in Daytona sandbox")
        : null,
    httpStatus: undefined as number | undefined,
  };
}

export { getDaytonaDevPort };
