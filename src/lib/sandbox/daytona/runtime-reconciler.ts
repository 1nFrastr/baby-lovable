/**
 * Daytona runtime reconciler — single writer that converges observed → desired.
 */

import { randomUUID } from "node:crypto";

import { getSessionOwner } from "@/lib/session/store";
import {
  DEV_SESSION,
  formatStartError,
  startDevSession,
  stopDevSession,
} from "./app-server-boot";
import {
  httpStatus,
  STARTING_DEV_HTTP_TIMEOUT_MS,
} from "./app-server-health";
import { logDaytonaBootstrap, logDaytonaTiming } from "./bootstrap-log";
import { getDaytonaDevPort } from "./config";
import { clearDaytonaAttachCache } from "./fs-attach-cache";
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
  resolveTargetDesired,
  runtimePatchChangesState,
  warmDesiredRank,
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
  sandboxRecordExists,
  wrapSandbox,
} from "./vm";

const LEASE_TTL_MS = 45_000;
const RECONCILE_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 2_000;
/** While waiting for Next after startDev — no Daytona reconnect between probes. */
const STARTING_DEV_POLL_INTERVAL_MS = 500;

function canLightProbeStartingDev(snapshot: DaytonaRuntimeSnapshot): boolean {
  return (
    snapshot.observed === "starting-devserver" &&
    Boolean(snapshot.sandboxId) &&
    Boolean(snapshot.previewUrl)
  );
}

function isStalePreviewLinkStatus(http: number): boolean {
  return http === 401 || http === 403 || http === 404 || http === 410;
}

/**
 * HTTP-only observe while pnpm/Next is booting. Skips Daytona reconnect —
 * the VM is already up; we only need the public URL to answer.
 */
async function observeStartingDevLight(
  sessionId: string,
  snapshot: DaytonaRuntimeSnapshot,
): Promise<ObservedRuntime> {
  const url = snapshot.previewUrl!;
  const port = snapshot.previewPort ?? getDaytonaDevPort();
  const t0 = Date.now();
  const probe = await httpStatus(
    url,
    undefined,
    STARTING_DEV_HTTP_TIMEOUT_MS,
  );
  const ready = probe >= 200 && probe < 400;
  logDaytonaTiming(
    sessionId,
    "reconcile.lightProbe",
    Date.now() - t0,
    `http=${probe} ready=${ready}`,
  );

  if (ready) {
    return {
      phase: "preview-ready",
      sandboxId: snapshot.sandboxId,
      sandboxState: null,
      previewUrl: url,
      previewPort: port,
      probeUrl: url,
      httpStatus: probe,
      lastError: null,
    };
  }

  return {
    phase: "workspace-ready",
    sandboxId: snapshot.sandboxId,
    sandboxState: null,
    previewUrl: url,
    previewPort: port,
    probeUrl: url,
    httpStatus: probe,
    lastError:
      probe >= 500
        ? null
        : `Preview returned HTTP ${probe}`,
    // httpStatus maps hang/abort → 503; treat like a soft miss.
    transient: probe === 503 || isStalePreviewLinkStatus(probe),
  };
}

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
  // Console / external delete: clear durable id so recreate + Freestyle hydrate run.
  if (observed.confirmedAbsent) {
    clearDaytonaAttachCache(snapshot.sessionId);
    return {
      observed: "missing",
      sandboxId: null,
      devSessionName: null,
      devCmdId: null,
      previewUrl: null,
      previewPort: null,
      lastError:
        observed.lastError ??
        "Daytona sandbox deleted externally — recreating from Freestyle",
      lastObservedAt: new Date().toISOString(),
      ...(snapshot.sandboxId
        ? { generation: snapshot.generation + 1 }
        : {}),
    };
  }

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
  if (observed.confirmedAbsent) {
    return false;
  }
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
  userId: string | null = null,
): Promise<DaytonaRuntimeSnapshot> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    const current = await getRuntimeSnapshot(sessionId, userId, {
      fresh: i > 0,
    });
    try {
      return await upsertRuntimeSnapshot(
        sessionId,
        {
          ...patch,
          expectedRevision: current.revision,
        },
        userId,
      );
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

/**
 * Clear durable sandbox binding after Daytona confirms the VM is gone
 * (console delete / GC). Bumps generation so stale observes drop.
 */
export async function markSandboxExternallyDeleted(
  sessionId: string,
  lastError =
    "Daytona sandbox deleted externally — recreating from Freestyle",
): Promise<DaytonaRuntimeSnapshot> {
  const current = await getRuntimeSnapshot(sessionId, null, { fresh: true });
  if (!current.sandboxId) {
    return current;
  }
  logDaytonaBootstrap(
    sessionId,
    "reconcile",
    `external delete — clear ${current.sandboxId.slice(0, 12)}`,
  );
  // Drop process-local FS handle so files/tools never keep using the dead id.
  clearDaytonaAttachCache(sessionId);
  return upsertWithRetry(sessionId, {
    sandboxId: null,
    observed: "missing",
    devSessionName: null,
    devCmdId: null,
    previewUrl: null,
    previewPort: null,
    generation: current.generation + 1,
    lastError,
  });
}

/**
 * Probe results that mean pnpm/proxy is actually down — restart is warranted.
 * `httpStatus` maps fetch timeout to 503, and Next also 503s while compiling;
 * those must not clobber a live preview-ready snapshot.
 */
function shouldRestartOnPreviewProbe(http: number): boolean {
  return http === 400 || http === 502;
}

/**
 * Durable said preview-ready but the public URL is unhealthy (502 / no-IP).
 * Demote so reconcile re-runs actionStartDev without recreating the VM or
 * clearing .next (cheaper than restart: true).
 */
async function demoteStalePreviewReady(
  sessionId: string,
  http: number,
): Promise<DaytonaRuntimeSnapshot> {
  const current = await getRuntimeSnapshot(sessionId, null, { fresh: true });
  logDaytonaBootstrap(
    sessionId,
    "preview",
    `stale ready — probe http=${http}; restarting pnpm dev only`,
  );
  return upsertWithRetry(sessionId, {
    observed: "workspace-ready",
    // Allow actionStartDev (reconcile skips when devSessionName is set).
    devSessionName: null,
    devCmdId: null,
    // The next pnpm dev command is a new log identity. Publish it immediately
    // so open consoles stop accepting chunks from the stale command.
    generation: current.generation + 1,
    lastError: `Preview probe HTTP ${http} — restarting pnpm dev`,
  });
}

/** Process-local create lock — duplicate after()/lease stealers share one VM create. */
const createInFlight = new Map<string, Promise<void>>();
/** Process-local Freestyle hydrate lock — create/reconcile share one background pull. */
const hydrateInFlight = new Map<string, Promise<void>>();
/** Isolate-local: already kicked background hydrate for this session. */
const hydrateKicked = new Set<string>();

type InflightEnsure = {
  requested: DaytonaDesiredState;
  promise: Promise<DaytonaRuntimeSnapshot>;
};

/** Same-isolate kick + after() share one reconcile, not a second ensure entry. */
const ensureInFlight = new Map<string, InflightEnsure>();

function canJoinInflightEnsure(
  inflightRequested: DaytonaDesiredState,
  requested: DaytonaDesiredState,
): boolean {
  if (requested === "stopped" || requested === "deleted") {
    return false;
  }
  if (inflightRequested === requested) {
    return true;
  }
  return warmDesiredRank(inflightRequested) >= warmDesiredRank(requested);
}

function trackEnsureInFlight(
  sessionId: string,
  requested: DaytonaDesiredState,
  work: Promise<DaytonaRuntimeSnapshot>,
): void {
  ensureInFlight.set(sessionId, { requested, promise: work });
  void work.finally(() => {
    const current = ensureInFlight.get(sessionId);
    if (current?.promise === work) {
      ensureInFlight.delete(sessionId);
    }
  });
}

/** Test helper — drop in-flight ensure/hydrate bookkeeping with L1. */
export function clearReconcileInFlightForTests(): void {
  ensureInFlight.clear();
  hydrateKicked.clear();
}

/**
 * Freestyle already has commits (e.g. sandbox recreate) — must pull before
 * trusting the workspace. New sessions have null remoteHeadSha; snapshot tree
 * matches the starter seed so hydrate can run after startDev.
 */
function needsBlockingFreestyleHydrate(remoteHeadSha: string | null | undefined) {
  return Boolean(remoteHeadSha);
}

/**
 * Seed + SDK pull into the sandbox. Does not change runtime observed phase on
 * failure (preview may already be up); provision error still blocks agent writes.
 */
function kickBackgroundFreestyleHydrate(
  sessionId: string,
  project: DaytonaProjectSandbox,
  userId: string | null,
): void {
  if (hydrateInFlight.has(sessionId)) {
    return;
  }

  const work = (async () => {
    const t0 = Date.now();
    try {
      const { hydrateWorkspaceFromFreestyle } = await import(
        "@/lib/git/hydrate-workspace"
      );
      const hydrate = await hydrateWorkspaceFromFreestyle(
        sessionId,
        project,
        userId,
      );
      logDaytonaTiming(
        sessionId,
        "action.hydrateFreestyle.bg",
        Date.now() - t0,
        `ok=${hydrate.ok}`,
      );
      if (!hydrate.ok) {
        logDaytonaBootstrap(
          sessionId,
          "reconcile",
          `background Freestyle hydrate failed: ${hydrate.error ?? "unknown"}`,
        );
        // Leave observed alone so startDev/preview keep running; barrier gates writes.
        await upsertWithRetry(sessionId, {
          lastError: hydrate.error ?? "Freestyle workspace hydrate failed",
        }).catch(() => {
          // best effort
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logDaytonaBootstrap(
        sessionId,
        "reconcile",
        `background Freestyle hydrate threw: ${message}`,
      );
    }
  })();

  hydrateInFlight.set(sessionId, work);
  void work.finally(() => {
    if (hydrateInFlight.get(sessionId) === work) {
      hydrateInFlight.delete(sessionId);
    }
  });
}

async function actionCreateSandbox(
  sessionId: string,
  snapshot: DaytonaRuntimeSnapshot,
  userId: string | null,
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

    await upsertWithRetry(
      sessionId,
      {
        observed: "creating-sandbox",
        lastError: null,
      },
      8,
      userId,
    );

    // Re-check after claiming the creating phase — another isolate may have created.
    let latest = await getRuntimeSnapshot(sessionId, null, { fresh: true });
    if (latest.sandboxId) {
      return;
    }

    const tCreate = Date.now();
    const sdk = await createSandbox(sessionId);
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

    // Freestyle: recreate (remoteHeadSha set) blocks; new sessions defer hydrate
    // so snapshot-baked workspace can start pnpm immediately.
    const { isFreestyleConfigured } = await import("@/lib/git/freestyle-config");
    if (isFreestyleConfigured()) {
      const { readGitRepository } = await import("@/lib/git/repository-store");
      const repo = await readGitRepository(sessionId, userId);
      const blockHydrate = needsBlockingFreestyleHydrate(repo?.remoteHeadSha);
      const project = wrapSandbox(sessionId, sdk);

      if (blockHydrate) {
        await upsertWithRetry(sessionId, {
          sandboxId: sdk.id,
          observed: "bootstrapping-workspace",
          lastError: null,
          previewPort,
          ...(previewUrl ? { previewUrl } : {}),
        });

        const { hydrateWorkspaceFromFreestyle } = await import(
          "@/lib/git/hydrate-workspace"
        );
        const tHydrate = Date.now();
        const hydrate = await hydrateWorkspaceFromFreestyle(
          sessionId,
          project,
          userId,
        );
        logDaytonaTiming(
          sessionId,
          "action.hydrateFreestyle",
          Date.now() - tHydrate,
          `ok=${hydrate.ok} mode=blocking`,
        );
        if (!hydrate.ok) {
          await upsertWithRetry(sessionId, {
            observed: "error",
            lastError: hydrate.error ?? "Freestyle workspace hydrate failed",
          });
          throw new Error(hydrate.error ?? "Freestyle workspace hydrate failed");
        }
        hydrateKicked.add(sessionId);
      } else {
        // Trust snapshot tree; seed/pull in background while startDev proceeds.
        kickBackgroundFreestyleHydrate(sessionId, project, userId);
        hydrateKicked.add(sessionId);
      }
    }

    const createdPatch = {
      sandboxId: sdk.id,
      observed: "workspace-ready" as const,
      lastError: null,
      previewPort,
      ...(previewUrl ? { previewUrl } : {}),
    };

    latest = await getRuntimeSnapshot(sessionId, null, { fresh: true });
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
    devCmdId: started.cmdId,
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
    devCmdId: null,
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
      const { isFreestyleConfigured } = await import(
        "@/lib/git/freestyle-config"
      );
      if (isFreestyleConfigured()) {
        try {
          const { flushPendingCheckpoints } = await import("@/lib/git/turn-sync");
          await flushPendingCheckpoints(sessionId, project);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          await upsertWithRetry(sessionId, {
            observed: "error",
            lastError: `Delete blocked — flush Freestyle checkpoint failed: ${message}`,
          });
          throw error;
        }
      }
      await stopDevSession(project, sessionId);
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
    devCmdId: null,
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
  userId: string | null,
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
  let latest = await getRuntimeSnapshot(sessionId, null, { fresh: true });
  if (latest.desired === "stopped" || latest.desired === "deleted") {
    // Desired flipped under us — let the next loop iteration handle it.
    return true;
  }

  // Console / external delete confirmed this tick but applyObservation may have
  // raced — clear durable id here so create can run.
  if (observed.confirmedAbsent && latest.sandboxId) {
    logDaytonaBootstrap(
      sessionId,
      "reconcile",
      `clear stale sandbox after external delete ${latest.sandboxId.slice(0, 12)}`,
    );
    clearDaytonaAttachCache(sessionId);
    latest = await upsertWithRetry(sessionId, {
      sandboxId: null,
      observed: "missing",
      devSessionName: null,
      devCmdId: null,
      previewUrl: null,
      previewPort: null,
      generation: latest.generation + 1,
      lastError:
        observed.lastError ??
        "Daytona sandbox deleted externally — recreating from Freestyle",
    });
  }

  // Observe timeout returns phase=missing with no sandboxId — do NOT treat that
  // as "sandbox gone" when durable state already has an id (would noop-create
  // forever and never reach startDev).
  if (!latest.sandboxId) {
    await actionCreateSandbox(sessionId, latest, userId);
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

  if (latest.observed === "creating-sandbox") {
    // Wait only while create (and optional blocking hydrate) is still in-process.
    if (createInFlight.has(sessionId)) {
      return false;
    }
    await upsertWithRetry(sessionId, {
      observed: "workspace-ready",
      lastError: null,
    });
    return true;
  }

  if (latest.observed === "bootstrapping-workspace") {
    // Blocking recreate hydrate (remoteHeadSha set) — wait for create/hydrate.
    if (createInFlight.has(sessionId) || hydrateInFlight.has(sessionId)) {
      return false;
    }
    const { isFreestyleConfigured } = await import("@/lib/git/freestyle-config");
    if (!isFreestyleConfigured()) {
      await upsertWithRetry(sessionId, {
        observed: "workspace-ready",
        lastError: null,
      });
      return true;
    }
    const { readGitRepository } = await import("@/lib/git/repository-store");
    const repo = await readGitRepository(sessionId);
    if (repo?.provisionStatus === "error") {
      await upsertWithRetry(sessionId, {
        observed: "error",
        lastError: repo.provisionError ?? "Freestyle hydrate failed",
      });
      return true;
    }
    if (
      repo?.provisionStatus === "ready" ||
      !needsBlockingFreestyleHydrate(repo?.remoteHeadSha)
    ) {
      await upsertWithRetry(sessionId, {
        observed: "workspace-ready",
        lastError: null,
      });
      return true;
    }
    return false;
  }

  if (desired === "sandbox-ready") {
    if ((await maybeKickBackgroundHydrate(sessionId, latest, userId)) === "abort") {
      return true;
    }
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

  if ((await maybeKickBackgroundHydrate(sessionId, latest, userId)) === "abort") {
    return true;
  }
  await actionStartDev(sessionId, latest);
  return true;
}

async function maybeKickBackgroundHydrate(
  sessionId: string,
  latest: DaytonaRuntimeSnapshot,
  userId: string | null,
): Promise<"ok" | "abort"> {
  if (hydrateKicked.has(sessionId) || hydrateInFlight.has(sessionId)) {
    return "ok";
  }
  if (!latest.sandboxId) {
    return "ok";
  }
  const { isFreestyleConfigured } = await import("@/lib/git/freestyle-config");
  if (!isFreestyleConfigured()) {
    return "ok";
  }
  const { readGitRepository } = await import("@/lib/git/repository-store");
  const repo = await readGitRepository(sessionId, userId);
  if (repo?.provisionStatus === "ready") {
    hydrateKicked.add(sessionId);
    return "ok";
  }
  if (needsBlockingFreestyleHydrate(repo?.remoteHeadSha)) {
    const project = await attachProject(sessionId, latest.sandboxId, false);
    if (!project) {
      return "ok";
    }
    await upsertWithRetry(
      sessionId,
      {
        observed: "bootstrapping-workspace",
        lastError: null,
      },
      8,
      userId,
    );
    const { hydrateWorkspaceFromFreestyle } = await import(
      "@/lib/git/hydrate-workspace"
    );
    const hydrate = await hydrateWorkspaceFromFreestyle(
      sessionId,
      project,
      userId,
    );
    if (!hydrate.ok) {
      await upsertWithRetry(
        sessionId,
        {
          observed: "error",
          lastError: hydrate.error ?? "Freestyle hydrate failed",
        },
        8,
        userId,
      );
      return "abort";
    }
    await upsertWithRetry(
      sessionId,
      {
        observed: "workspace-ready",
        lastError: null,
      },
      8,
      userId,
    );
    hydrateKicked.add(sessionId);
    return "ok";
  }

  const project = await attachProject(sessionId, latest.sandboxId, false);
  if (project) {
    kickBackgroundFreestyleHydrate(sessionId, project, userId);
    hydrateKicked.add(sessionId);
  }
  return "ok";
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
  userId: string | null,
): Promise<DaytonaRuntimeSnapshot> {
  while (Date.now() < deadline) {
    // One durable read per tick. Renew persists only when the lease is
    // past half TTL; observe writes only when control-plane fields change.
    let snapshot = await getRuntimeSnapshot(sessionId, userId, { fresh: true });
    const renewed = await renewRuntimeLease(
      sessionId,
      owner,
      LEASE_TTL_MS,
      userId,
      { current: snapshot },
    );
    if (renewed) {
      snapshot = renewed;
    }

    const tObserve = Date.now();
    let usedLightProbe = canLightProbeStartingDev(snapshot);
    let observed: ObservedRuntime;
    if (usedLightProbe) {
      observed = await observeStartingDevLight(sessionId, snapshot);
      // Stale proxy URL — refresh via full Daytona observe once.
      if (
        observed.httpStatus != null &&
        isStalePreviewLinkStatus(observed.httpStatus)
      ) {
        usedLightProbe = false;
        observed = await observeRuntime(sessionId, {
          wake: true,
          snapshot,
        });
      }
    } else {
      observed = await observeRuntime(sessionId, {
        wake:
          snapshot.desired === "sandbox-ready" ||
          snapshot.desired === "preview-ready" ||
          snapshot.desired === "deleted",
        snapshot,
      });
    }
    logDaytonaTiming(
      sessionId,
      "reconcile.observe",
      Date.now() - tObserve,
      `phase=${observed.phase} http=${observed.httpStatus ?? "null"} err=${observed.lastError ?? "none"} durable=${snapshot.observed}${usedLightProbe ? " light=1" : ""}`,
    );

    if (shouldPreserveSnapshotOnObserveMiss(observed, snapshot)) {
      logDaytonaTiming(
        sessionId,
        "reconcile.observe",
        0,
        `preserved durable=${snapshot.observed} after transient miss`,
      );
      snapshot = await getRuntimeSnapshot(sessionId, userId, { fresh: true });
    } else {
      const obsPatch = applyObservation(snapshot, observed);
      if (runtimePatchChangesState(snapshot, obsPatch)) {
        try {
          snapshot = await upsertRuntimeSnapshot(
            sessionId,
            {
              expectedRevision: snapshot.revision,
              ...obsPatch,
            },
            userId,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/CAS conflict/i.test(message)) {
            throw error;
          }
          snapshot = await getRuntimeSnapshot(sessionId, userId, {
            fresh: true,
          });
          continue;
        }
      }
    }

    // HTTP can recover after a stale-ready demotion before startDev runs.
    // Restore the deterministic process identity before declaring convergence.
    if (snapshot.observed === "preview-ready" && !snapshot.devSessionName) {
      snapshot = await upsertWithRetry(
        sessionId,
        {
          devSessionName: DEV_SESSION(sessionId),
          lastError: null,
        },
        8,
        userId,
      );
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

    // Light-probe wait: Next is already starting — skip reconcileOnce until
    // HTTP succeeds or we need an action.
    let acted = false;
    if (
      !(
        usedLightProbe &&
        observed.phase !== "preview-ready" &&
        snapshot.observed === "starting-devserver"
      )
    ) {
      const tAction = Date.now();
      acted = await reconcileOnce(sessionId, snapshot, observed, userId);
      logDaytonaTiming(
        sessionId,
        "reconcile.action",
        Date.now() - tAction,
        `acted=${acted} desired=${snapshot.desired} observed=${snapshot.observed}`,
      );
    }
    if (!acted) {
      const pollMs =
        canLightProbeStartingDev(snapshot) || usedLightProbe
          ? STARTING_DEV_POLL_INTERVAL_MS
          : POLL_INTERVAL_MS;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  const timedOut = await getRuntimeSnapshot(sessionId, userId, { fresh: true });
  if (isDesiredSatisfied({ ...timedOut, desired: returnWhen })) {
    return timedOut;
  }
  if (!isDesiredSatisfied(timedOut)) {
    return upsertRuntimeSnapshot(
      sessionId,
      {
        expectedRevision: timedOut.revision,
        observed: "error",
        lastError:
          timedOut.lastError ??
          `Timed out reconciling to ${timedOut.desired}`,
      },
      userId,
    );
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

  const sessionOwner = await getSessionOwner(sessionId);
  if (!sessionOwner) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  if (sessionOwner.sandboxMode !== "daytona") {
    throw new Error(`Session ${sessionId} is not in daytona mode`);
  }
  const userId = sessionOwner.userId;

  let snapshot = await getRuntimeSnapshot(sessionId, userId, { fresh: true });

  // What the caller needs vs what we write as durable desired.
  // FS attach requests sandbox-ready; UI warm may already have preview-ready —
  // resolveTargetDesired never demotes the warm ladder, but FS still returns
  // once the VM exists (see reconcileLoop returnWhen).
  const requestedDesired = desired;
  let targetDesired = resolveTargetDesired(snapshot.desired, requestedDesired, {
    restart: options?.restart,
  });

  // Already have what the caller asked for (e.g. workspace ready while preview installs).
  // Do not trust durable preview-ready blindly — probe the public URL first so a
  // dead pnpm (502) or sleepy networking (400 no-IP) re-triggers startDev
  // without a full restart/recreate. Timeout / compile 503 is inconclusive:
  // demoting those overwrites a live preview with "starting" and kills pnpm.
  if (
    !options?.restart &&
    isDesiredSatisfied({ ...snapshot, desired: requestedDesired }) &&
    (requestedDesired !== "preview-ready" || hasFreshPreviewEmbed(snapshot))
  ) {
    if (
      snapshot.sandboxId &&
      (requestedDesired === "sandbox-ready" ||
        requestedDesired === "preview-ready")
    ) {
      const exists = await sandboxRecordExists(snapshot.sandboxId);
      if (!exists) {
        // Console / external delete left a zombie id — clear and fall through to recreate.
        snapshot = await markSandboxExternallyDeleted(sessionId);
      } else if (
        requestedDesired === "preview-ready" &&
        snapshot.previewUrl
      ) {
        const tProbe = Date.now();
        const probe = await httpStatus(snapshot.previewUrl);
        logDaytonaTiming(
          sessionId,
          "ensure.previewProbe",
          Date.now() - tProbe,
          `http=${probe}`,
        );
        if (!shouldRestartOnPreviewProbe(probe)) {
          if (probe >= 400) {
            logDaytonaTiming(
              sessionId,
              "ensure.previewProbe",
              0,
              `keep ready — transient http=${probe}`,
            );
          }
          if (!snapshot.devSessionName) {
            snapshot = await upsertWithRetry(sessionId, {
              devSessionName: DEV_SESSION(sessionId),
              lastError: null,
            });
          }
          return snapshot;
        }
        snapshot = await demoteStalePreviewReady(sessionId, probe);
        // Fall through → reconcile actionStartDev (keep VM + .next).
      } else {
        // sandbox-ready: VM record exists is enough.
        return snapshot;
      }
    } else {
      return snapshot;
    }
  }

  let intentGeneration = snapshot.generation + 1;
  const maxDesiredAttempts = 12;
  for (let attempt = 0; attempt < maxDesiredAttempts; attempt++) {
    // Re-merge on every attempt — a concurrent writer may have raised warm
    // desired or landed stop/delete since our last read.
    targetDesired = resolveTargetDesired(snapshot.desired, requestedDesired, {
      restart: options?.restart,
      casRetry: attempt > 0,
    });

    // Durable already holds the merge result — adopt; do not bump generation
    // just to rewrite the same desired (that used to demote preview→sandbox).
    if (
      !options?.restart &&
      attempt > 0 &&
      snapshot.desired === targetDesired
    ) {
      break;
    }

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
      snapshot = await upsertRuntimeSnapshot(sessionId, patch, userId);
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/CAS conflict/i.test(message) || attempt === maxDesiredAttempts - 1) {
        throw error;
      }
      snapshot = await getRuntimeSnapshot(sessionId, null, { fresh: true });
      // Another intent landed — claim a newer generation and retry with re-merge.
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

  const inflight = ensureInFlight.get(sessionId);
  if (
    inflight &&
    !options?.restart &&
    canJoinInflightEnsure(inflight.requested, requestedDesired)
  ) {
    if (!wait) {
      return snapshot;
    }
    return inflight.promise;
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
        userId,
      );
    } catch (error) {
      const detail = formatStartError(error);
      logDaytonaBootstrap(sessionId, "reconcile", `failed: ${detail.slice(0, 200)}`, {
        generation: snapshot.generation,
        leaseOwner: owner,
      });
      try {
        const cur = await getRuntimeSnapshot(sessionId, userId, { fresh: true });
        result = await upsertRuntimeSnapshot(
          sessionId,
          {
            expectedRevision: cur.revision,
            observed: "error",
            lastError: detail,
          },
          userId,
        );
      } catch {
        result = await getRuntimeSnapshot(sessionId, userId, { fresh: true });
      }
    } finally {
      await releaseRuntimeLease(sessionId, owner, userId);
    }
    afterSandboxReadyForPreview(result);
    return result;
  };

  const run = async (): Promise<DaytonaRuntimeSnapshot> => {
    const leased = await acquireRuntimeLease(
      sessionId,
      owner,
      LEASE_TTL_MS,
      userId,
    );
    if (!leased) {
      // Another writer holds the lease — wait for convergence if requested.
      if (!wait) {
        return snapshot;
      }
      const deadline = Date.now() + RECONCILE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const current = await getRuntimeSnapshot(sessionId, userId, {
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
        const again = await acquireRuntimeLease(
          sessionId,
          owner,
          LEASE_TTL_MS,
          userId,
        );
        if (again) {
          return runWithLease(deadline);
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      return getRuntimeSnapshot(sessionId, userId, { fresh: true });
    }

    return runWithLease(Date.now() + RECONCILE_TIMEOUT_MS);
  };

  const work = run();
  trackEnsureInFlight(sessionId, requestedDesired, work);
  if (!wait) {
    void work.catch(() => {
      // logged inside
    });
    return snapshot;
  }

  return work;
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

  const obsPatch = {
    ...applyObservation(snapshot, observed),
    ...(observed.phase === "preview-ready"
      ? {
          previewUrl: observed.previewUrl,
          previewPort: observed.previewPort,
        }
      : {}),
  };
  if (!runtimePatchChangesState(snapshot, obsPatch)) {
    return snapshot;
  }

  try {
    snapshot = await upsertRuntimeSnapshot(sessionId, {
      expectedRevision: snapshot.revision,
      ...obsPatch,
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
    const obsPatch = {
      ...applyObservation(snapshot, observed),
      ...(observed.phase === "preview-ready"
        ? {
            previewUrl: observed.previewUrl,
            previewPort: observed.previewPort,
          }
        : {}),
    };
    if (runtimePatchChangesState(snapshot, obsPatch)) {
      try {
        await upsertRuntimeSnapshot(sessionId, {
          expectedRevision: snapshot.revision,
          ...obsPatch,
        });
      } catch {
        // CAS — ignore; check result still uses live observe / peek
      }
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
