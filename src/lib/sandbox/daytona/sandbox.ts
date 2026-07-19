/** Sandbox layer shim: getExisting / getOrCreate / delete / status → reconciler. */
import type { SandboxStatus } from "../preview-types";
import type { DaytonaProjectSandbox } from "./provider";
import {
  deriveSandboxStatus,
  isDesiredSatisfied,
  type DaytonaRuntimeSnapshot,
} from "./runtime-state";
import { ensureDesiredState } from "./runtime-reconciler";
import { getRuntimeSnapshot } from "./runtime-store";
import { getSession } from "@/lib/session/store";
import { reconnectSandbox, wrapSandbox } from "./vm";

/** If durable desired is still below preview, re-kick reconciler (non-blocking). */
function kickPreviewWarmIfNeeded(snapshot: DaytonaRuntimeSnapshot): void {
  if (snapshot.desired === "deleted" || snapshot.desired === "stopped") {
    return;
  }
  if (isDesiredSatisfied({ ...snapshot, desired: "preview-ready" })) {
    return;
  }
  // Same path as chat/preview prelude — no separate warm runner.
  void ensureDesiredState(snapshot.sessionId, "preview-ready", {
    wait: false,
  }).catch(() => {
    // best-effort
  });
}

/**
 * Process-local FS attach cache.
 * Parallel tool steps in one isolate share one reconnect; sequential tools reuse it.
 * Durable snapshot remains source of truth across isolates.
 */
const attachBySession = new Map<string, Promise<DaytonaProjectSandbox>>();

/**
 * Snapshot already has a usable workspace — skip reconcile.
 * Once sandboxId is written, attach even while warm is still in
 * bootstrapping/install (prebuilt Daytona snapshot ships the starter).
 */
export function canFastAttachSandbox(
  snapshot: DaytonaRuntimeSnapshot,
): boolean {
  if (!snapshot.sandboxId) {
    return false;
  }
  if (snapshot.desired === "deleted") {
    return false;
  }
  if (isDesiredSatisfied({ ...snapshot, desired: "sandbox-ready" })) {
    return true;
  }
  return (
    snapshot.observed === "creating-sandbox" ||
    snapshot.observed === "bootstrapping-workspace" ||
    snapshot.observed === "installing-deps" || // legacy persisted
    snapshot.observed === "starting-devserver" ||
    snapshot.observed === "workspace-ready" ||
    snapshot.observed === "preview-ready"
  );
}

async function reconnectProject(
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

/**
 * Attach for FS / process tools.
 * Fast path: runtime says sandbox-ready → one Daytona get (no ensureDesiredState,
 * no workspace check). Cold path: ensure once, then attach.
 */
async function attachDaytonaSandboxForFsOnce(
  sessionId: string,
): Promise<DaytonaProjectSandbox> {
  const session = await getSession(sessionId);
  if (!session || session.sandboxMode !== "daytona") {
    throw new Error(`Session ${sessionId} is not a Daytona sandbox session`);
  }

  let snapshot = await getRuntimeSnapshot(sessionId, null, { fresh: true });

  if (canFastAttachSandbox(snapshot) && snapshot.sandboxId) {
    const project = await reconnectProject(
      sessionId,
      snapshot.sandboxId,
      true,
    );
    if (project) {
      kickPreviewWarmIfNeeded(snapshot);
      return project;
    }
  }

  snapshot = await ensureDesiredState(sessionId, "sandbox-ready", {
    wait: true,
  });
  if (!snapshot.sandboxId) {
    throw new Error(`Daytona sandbox not ready for session ${sessionId}`);
  }

  const project = await reconnectProject(sessionId, snapshot.sandboxId, true);
  if (!project) {
    throw new Error(`Failed to attach Daytona sandbox ${snapshot.sandboxId}`);
  }
  kickPreviewWarmIfNeeded(snapshot);
  return project;
}

/**
 * Coalesced FS attach for the current isolate.
 * Prefer this over ensureDesiredState + getExisting for tool I/O.
 */
export function attachDaytonaSandboxForFs(
  sessionId: string,
): Promise<DaytonaProjectSandbox> {
  const pending = attachBySession.get(sessionId);
  if (pending) {
    return pending;
  }

  const promise = attachDaytonaSandboxForFsOnce(sessionId).catch((error) => {
    if (attachBySession.get(sessionId) === promise) {
      attachBySession.delete(sessionId);
    }
    throw error;
  });

  attachBySession.set(sessionId, promise);
  return promise;
}

export function clearDaytonaAttachCache(sessionId: string): void {
  attachBySession.delete(sessionId);
}

/** Read-only — durable snapshot only (no Daytona observe / get). */
export async function getDaytonaSandboxStatus(
  sessionId: string,
): Promise<SandboxStatus> {
  const snapshot = await getRuntimeSnapshot(sessionId, null, { fresh: true });
  return deriveSandboxStatus(snapshot);
}

/**
 * Reconnect to runtime sandboxId — never create.
 * wake=false: do not start stopped VMs.
 */
export async function getExistingDaytonaSandbox(
  sessionId: string,
  options?: { wake?: boolean },
): Promise<DaytonaProjectSandbox | null> {
  const wake = options?.wake ?? false;
  const session = await getSession(sessionId);
  if (!session || session.sandboxMode !== "daytona") {
    return null;
  }

  const snapshot = await getRuntimeSnapshot(sessionId);
  if (!snapshot.sandboxId) {
    return null;
  }

  return reconnectProject(sessionId, snapshot.sandboxId, wake);
}

/** Reconnect or create via reconciler. Agent turn / export / cold start. */
export async function getOrCreateDaytonaSandbox(
  sessionId: string,
): Promise<DaytonaProjectSandbox> {
  return attachDaytonaSandboxForFs(sessionId);
}

export async function deleteDaytonaSandbox(sessionId: string): Promise<void> {
  clearDaytonaAttachCache(sessionId);
  await ensureDesiredState(sessionId, "deleted", { wait: true });
}
