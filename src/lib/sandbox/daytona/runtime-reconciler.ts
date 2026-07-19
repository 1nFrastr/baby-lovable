/**
 * Daytona runtime reconciler — single writer that converges observed → desired.
 */

import { randomUUID } from "node:crypto";

import { getSession } from "@/lib/session/store";
import { commitWorkspaceTurn } from "../workspace-git";

import {
  formatStartError,
  startDevSession,
  stopDevSession,
} from "./app-server-boot";
import { httpStatus } from "./app-server-health";
import { logDaytonaBootstrap, logDaytonaTiming } from "./bootstrap-log";
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
import {
  createSandbox,
  deleteSandboxById,
  ensureSandboxPublic,
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
  /**
   * When wait=false, default kicks reconcile in the background.
   * Set kick=false to only persist desired (route schedules after() warm).
   */
  kick?: boolean;
}

function applyObservation(
  snapshot: DaytonaRuntimeSnapshot,
  observed: ObservedRuntime,
): Partial<DaytonaRuntimeSnapshot> {
  const controllerPhases = new Set<string>([
    "creating-sandbox",
    "starting-devserver",
    "stopping",
    "deleting",
  ]);

  let phase = observed.phase;

  if (
    snapshot.observed === "starting-devserver" &&
    observed.phase === "preview-ready"
  ) {
    phase = "preview-ready";
  } else if (
    (snapshot.observed === "creating-sandbox" ||
      snapshot.observed === "bootstrapping-workspace") &&
    observed.phase !== "missing" &&
    (observed.sandboxId ?? snapshot.sandboxId)
  ) {
    // Snapshot ships the workspace — promote as soon as the VM exists.
    phase =
      observed.phase === "preview-ready" ? "preview-ready" : "workspace-ready";
  } else if (
    controllerPhases.has(snapshot.observed) &&
    snapshot.observed !== "error" &&
    observed.phase !== "preview-ready"
  ) {
    // Keep transitional controller phase while action is in flight.
    // Critical: observe timeout returns phase=missing — must NOT clobber
    // starting-devserver or we startDev twice and reset Next boot.
    const sandboxStillKnown = Boolean(
      observed.sandboxId ?? snapshot.sandboxId,
    );
    if (observed.phase === "missing" && !sandboxStillKnown) {
      phase = "missing";
    } else {
      phase = snapshot.observed;
    }
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
  if (observed.transient) {
    return true;
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

/** Process-local create lock — duplicate after()/lease stealers share one VM create. */
const createInFlight = new Map<string, Promise<void>>();

async function actionCreateSandbox(
  sessionId: string,
  snapshot: DaytonaRuntimeSnapshot,
): Promise<void> {
  if (snapshot.sandboxId) {
    return;
  }

  const pending = createInFlight.get(sessionId);
  if (pending) {
    logDaytonaBootstrap(sessionId, "reconcile", "create coalesce — in flight");
    await pending;
    return;
  }

  const work = (async () => {
    const t0 = Date.now();
    const session = await getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    await upsertWithRetry(sessionId, {
      observed: "creating-sandbox",
      lastError: null,
    });

    // Re-check after claiming the creating phase — another isolate may have created.
    let latest = await getRuntimeSnapshot(sessionId, null, { fresh: true });
    if (latest.sandboxId) {
      return;
    }

    const tCreate = Date.now();
    const sdk = await createSandbox(session);
    logDaytonaTiming(
      sessionId,
      "action.createSandbox",
      Date.now() - tCreate,
      `id=${sdk.id}`,
    );

    // CAS: only the first writer keeps the id; losers delete the orphan VM.
    latest = await getRuntimeSnapshot(sessionId, null, { fresh: true });
    if (latest.sandboxId && latest.sandboxId !== sdk.id) {
      logDaytonaBootstrap(
        sessionId,
        "reconcile",
        `create orphan — peer won kept=${latest.sandboxId.slice(0, 12)}`,
      );
      await deleteSandboxById(sessionId, sdk.id);
      return;
    }

    const previewPort = getDaytonaDevPort();
    let previewUrl: string | null = null;
    try {
      await ensureSandboxPublic(sdk);
      const link = await sdk.getPreviewLink(previewPort);
      previewUrl = link.url;
    } catch {
      // iframe can wait until startDev; create still succeeds
    }

    const createdPatch = {
      sandboxId: sdk.id,
      // Snapshot already has starter + deps — no seed / bootstrap step.
      observed: "workspace-ready" as const,
      lastError: null,
      previewPort,
      ...(previewUrl ? { previewUrl } : {}),
    };

    try {
      await upsertRuntimeSnapshot(sessionId, {
        expectedRevision: latest.revision,
        ...createdPatch,
      });
    } catch {
      const again = await getRuntimeSnapshot(sessionId, null, { fresh: true });
      if (again.sandboxId && again.sandboxId !== sdk.id) {
        logDaytonaBootstrap(
          sessionId,
          "reconcile",
          `create orphan — CAS lost kept=${again.sandboxId.slice(0, 12)}`,
        );
        await deleteSandboxById(sessionId, sdk.id);
        return;
      }
      await upsertWithRetry(sessionId, createdPatch);
    }
    logDaytonaTiming(sessionId, "action.createSandbox.total", Date.now() - t0);
  })();

  createInFlight.set(sessionId, work);
  try {
    await work;
  } finally {
    if (createInFlight.get(sessionId) === work) {
      createInFlight.delete(sessionId);
    }
  }
}

async function actionStartDev(
  sessionId: string,
  snapshot: DaytonaRuntimeSnapshot,
): Promise<void> {
  if (!snapshot.sandboxId) {
    return;
  }
  const t0 = Date.now();
  const project = await attachProject(sessionId, snapshot.sandboxId, true);
  logDaytonaTiming(
    sessionId,
    "action.startDev.attach",
    Date.now() - t0,
    `ok=${Boolean(project)}`,
  );
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

  const tStart = Date.now();
  const started = await startDevSession(project, sessionId);
  logDaytonaTiming(sessionId, "action.startDev.session", Date.now() - tStart);

  // Publish the public proxy URL immediately so the UI can mount the iframe
  // while Next is still booting (502 until ready). Do not wait for observe.
  let previewUrl = snapshot.previewUrl;
  try {
    await ensureSandboxPublic(project.sdkSandbox);
    const link = await project.sdkSandbox.getPreviewLink(started.port);
    previewUrl = link.url;
  } catch {
    // keep prior url if any
  }

  await upsertWithRetry(sessionId, {
    observed: "starting-devserver",
    devSessionName: started.sessionName,
    previewPort: started.port,
    ...(previewUrl ? { previewUrl } : {}),
  });
  logDaytonaTiming(sessionId, "action.startDev.total", Date.now() - t0);
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
      snapshot.observed === "creating-sandbox" ||
      snapshot.observed === "bootstrapping-workspace" || // legacy
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

  // Observe timeout returns phase=missing with no sandboxId — do NOT treat that
  // as "sandbox gone" when durable state already has an id (would noop-create
  // forever and never reach startDev).
  if (!latest.sandboxId) {
    await actionCreateSandbox(sessionId, latest);
    return true;
  }
  if (observed.phase === "missing" && !observed.sandboxId) {
    logDaytonaTiming(
      sessionId,
      "reconcile.skipMissingObserve",
      0,
      `durableSandbox=${latest.sandboxId.slice(0, 12)} err=${observed.lastError ?? "none"}`,
    );
    return false;
  }

  if (
    latest.observed === "creating-sandbox" ||
    latest.observed === "bootstrapping-workspace"
  ) {
    await upsertWithRetry(sessionId, {
      observed: "workspace-ready",
      lastError: null,
    });
    return true;
  }

  if (desired === "sandbox-ready") {
    return false;
  }

  // preview-ready — go straight to pnpm dev (workspace baked into snapshot).
  if (observed.phase === "preview-ready" && !latest.clearNextCache) {
    return false;
  }

  // Idempotent: do not kill an in-flight Next boot (startDevSession deletes
  // the old session first — a second call resets ~30s of progress).
  if (latest.clearNextCache) {
    await actionStartDev(sessionId, latest);
    return true;
  }
  if (
    latest.observed === "starting-devserver" ||
    Boolean(latest.devSessionName)
  ) {
    return false;
  }

  await actionStartDev(sessionId, latest);
  return true;
}

async function reconcileLoop(
  sessionId: string,
  owner: string,
  deadline: number,
  /**
   * Caller wait target. FS attach asks for sandbox-ready even when durable
   * desired stays preview-ready — return as soon as the VM exists; do not
   * block on next dev.
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

    const tObserve = Date.now();
    const observed = await observeRuntime(sessionId, {
      wake:
        snapshot.desired === "sandbox-ready" ||
        snapshot.desired === "preview-ready" ||
        snapshot.desired === "deleted",
      snapshot,
    });
    logDaytonaTiming(
      sessionId,
      "reconcile.observe",
      Date.now() - tObserve,
      `phase=${observed.phase} http=${observed.httpStatus ?? "null"} err=${observed.lastError ?? "none"} durable=${snapshot.observed}`,
    );

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

    const tAction = Date.now();
    const acted = await reconcileOnce(sessionId, snapshot, observed);
    logDaytonaTiming(
      sessionId,
      "reconcile.action",
      Date.now() - tAction,
      `acted=${acted} desired=${snapshot.desired} observed=${snapshot.observed}`,
    );
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

  // Intent-only: persist desired, let the caller schedule after()/warm separately.
  if (!wait && options?.kick === false) {
    return snapshot;
  }

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
        // FS attach: once the VM id exists, do not sit on warm's lease through
        // bootstrap/install. Prebuilt snapshot already has the starter tree.
        if (
          requestedDesired === "sandbox-ready" &&
          current.sandboxId &&
          current.desired !== "deleted"
        ) {
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
 * Compile diagnosis lives on write/edit (`compileError` via peekCompileError).
 * This probe only answers: is the preview URL up (HTTP < 500)?
 *
 * Fast path (durable preview-ready + url): HTTP probe only — no Daytona
 * reconnect, no remote dev-log read.
 * Full observe when embed is not fresh yet.
 */
export async function checkRuntimePreview(sessionId: string) {
  const t0 = Date.now();
  const snapshot = await getRuntimeSnapshot(sessionId, null, { fresh: true });
  const fresh = hasFreshPreviewEmbed(snapshot);
  logDaytonaTiming(
    sessionId,
    "checkRuntimePreview.start",
    0,
    `observed=${snapshot.observed} freshEmbed=${fresh} sandboxId=${snapshot.sandboxId ? "yes" : "no"}`,
  );

  if (fresh && snapshot.previewUrl) {
    const tProbe = Date.now();
    const probe = await httpStatus(snapshot.previewUrl);
    logDaytonaTiming(
      sessionId,
      "checkRuntimePreview.fast.http",
      Date.now() - tProbe,
      `http=${probe}`,
    );

    // 502/5xx: durable said ready but proxy still unhealthy — keep waiting.
    if (probe >= 500) {
      logDaytonaTiming(
        sessionId,
        "checkRuntimePreview.total",
        Date.now() - t0,
        "path=fast status=starting http>=500",
      );
      return {
        status: "starting" as const,
        url: snapshot.previewUrl,
        buildError: null,
        httpStatus: probe,
      };
    }

    logDaytonaTiming(
      sessionId,
      "checkRuntimePreview.total",
      Date.now() - t0,
      "path=fast status=ready",
    );
    return {
      status: "ready" as const,
      url: snapshot.previewUrl,
      buildError: null,
      httpStatus: probe,
    };
  }

  const tObserve = Date.now();
  const observed = await observeRuntime(sessionId, {
    wake: false,
    snapshot,
  });
  logDaytonaTiming(
    sessionId,
    "checkRuntimePreview.observe",
    Date.now() - tObserve,
    `phase=${observed.phase} http=${observed.httpStatus ?? "null"} err=${observed.lastError ?? "none"}`,
  );

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

  // observeRuntime already probed HTTP when preview-ready (no compile log).
  if (observed.phase === "preview-ready") {
    const url = observed.previewUrl ?? snapshot.previewUrl ?? undefined;
    const probe = observed.httpStatus ?? undefined;
    if (probe !== undefined && probe >= 500) {
      logDaytonaTiming(
        sessionId,
        "checkRuntimePreview.total",
        Date.now() - t0,
        "path=observe status=starting http>=500",
      );
      return {
        status: "starting" as const,
        url,
        buildError: null,
        httpStatus: probe,
      };
    }
    logDaytonaTiming(
      sessionId,
      "checkRuntimePreview.total",
      Date.now() - t0,
      "path=observe status=ready",
    );
    return {
      status: "ready" as const,
      url,
      buildError: null,
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
    const tHttp = Date.now();
    const probe = await httpStatus(snapshot.previewUrl);
    logDaytonaTiming(
      sessionId,
      "checkRuntimePreview.preserve.http",
      Date.now() - tHttp,
      `http=${probe}`,
    );
    if (probe >= 500) {
      logDaytonaTiming(
        sessionId,
        "checkRuntimePreview.total",
        Date.now() - t0,
        "path=preserve status=starting",
      );
      return {
        status: "starting" as const,
        url: snapshot.previewUrl,
        buildError: null,
        httpStatus: probe,
      };
    }
    logDaytonaTiming(
      sessionId,
      "checkRuntimePreview.total",
      Date.now() - t0,
      "path=preserve status=ready",
    );
    return {
      status: "ready" as const,
      url: snapshot.previewUrl,
      buildError: null,
      httpStatus: probe,
    };
  }

  const latest = await getRuntimeSnapshot(sessionId, null, { fresh: true });
  const app = deriveAppServerStatus(latest);

  logDaytonaTiming(
    sessionId,
    "checkRuntimePreview.total",
    Date.now() - t0,
    `path=derive status=${app.status}`,
  );
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
