import type { Session } from "@/lib/session/types";
import {
  claimDaytonaSandboxId,
  getSession,
  updateSession,
} from "@/lib/session/store";

import { DAYTONA_VOLUME_MOUNT, getDaytonaSnapshotName } from "./config";
import { getDaytonaClient } from "./client";
import { logDaytonaBootstrap } from "./bootstrap-log";
import { ensureSharedVolume } from "./volume";
import { DaytonaProjectSandbox } from "../daytona-provider";
import { ensureDaytonaWorkspace } from "./workspace-bootstrap";
import { commitWorkspaceTurn } from "../workspace-git";
import { persistDaytonaWorkspaceToVolume } from "./volume-sync";
import type { Sandbox } from "@daytona/sdk";

interface ManagedEntry {
  sandbox: Sandbox;
  projectSandbox: DaytonaProjectSandbox;
  lastActivity: number;
}

const managed = new Map<string, ManagedEntry>();
const ensurePromises = new Map<string, Promise<DaytonaProjectSandbox>>();

const RECONNECT_ATTEMPTS = 3;

function touchActivity(sessionId: string): void {
  const entry = managed.get(sessionId);
  if (entry) {
    entry.lastActivity = Date.now();
  }
}

async function persistSandboxId(
  sessionId: string,
  sandboxId: string | null,
): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) {
    return;
  }

  await updateSession(sessionId, {
    daytonaSandboxId: sandboxId,
  });
}

async function clearPreviewMemory(sessionId: string): Promise<void> {
  try {
    const { clearDaytonaPreviewMemory } = await import("../dev-server-daytona");
    clearDaytonaPreviewMemory(sessionId);
  } catch {
    // Preview module may be unavailable in some CLI paths.
  }
}

function dropManagedEntry(sessionId: string): void {
  managed.delete(sessionId);
  void clearPreviewMemory(sessionId);
}

async function tryGetExistingSandbox(
  sessionId: string,
  sandboxId: string,
): Promise<Sandbox | null> {
  const daytona = getDaytonaClient();
  logDaytonaBootstrap(sessionId, "sandbox", `reconnecting to sandbox ${sandboxId}`);
  try {
    const sandbox = await daytona.get(sandboxId);
    if (sandbox.state === "stopped" || sandbox.state === "archived") {
      logDaytonaBootstrap(sessionId, "sandbox", `starting sandbox (state=${sandbox.state})`);
      await sandbox.start(120);
    }
    await sandbox.waitUntilStarted(120);
    logDaytonaBootstrap(sessionId, "sandbox", `reconnected to sandbox ${sandbox.id}`);
    return sandbox;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logDaytonaBootstrap(
      sessionId,
      "sandbox",
      `sandbox ${sandboxId} unavailable (${detail.slice(0, 160)})`,
    );
    return null;
  }
}

async function reconnectWithRetries(
  sessionId: string,
  sandboxId: string,
): Promise<Sandbox | null> {
  for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt++) {
    const sandbox = await tryGetExistingSandbox(sessionId, sandboxId);
    if (sandbox) {
      return sandbox;
    }
    if (attempt < RECONNECT_ATTEMPTS) {
      logDaytonaBootstrap(
        sessionId,
        "sandbox",
        `reconnect retry ${attempt}/${RECONNECT_ATTEMPTS} for ${sandboxId}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
    }
  }
  logDaytonaBootstrap(
    sessionId,
    "sandbox",
    `sandbox ${sandboxId} still unavailable after ${RECONNECT_ATTEMPTS} attempts — will create new`,
  );
  return null;
}

async function deleteSandboxBestEffort(
  sessionId: string,
  sandbox: Sandbox,
  reason: string,
): Promise<void> {
  logDaytonaBootstrap(
    sessionId,
    "sandbox",
    `deleting sandbox ${sandbox.id} (${reason})`,
  );
  try {
    await sandbox.delete(60);
  } catch {
    // Sandbox may already be gone.
  }
}

/**
 * After creating a sandbox, CAS-claim session.daytonaSandboxId.
 * If another isolate already claimed a different id, adopt that one and delete ours.
 */
async function claimOrAdoptSandbox(
  sessionId: string,
  created: Sandbox,
): Promise<Sandbox> {
  const result = await claimDaytonaSandboxId(sessionId, created.id);

  if (result.claimed || result.daytonaSandboxId === created.id) {
    logDaytonaBootstrap(
      sessionId,
      "sandbox",
      `claimed sandbox id ${created.id}`,
    );
    return created;
  }

  if (result.daytonaSandboxId) {
    logDaytonaBootstrap(
      sessionId,
      "sandbox",
      `lost create race — adopting ${result.daytonaSandboxId}, discarding ${created.id}`,
    );
    await deleteSandboxBestEffort(sessionId, created, "lost create race");
    const adopted = await reconnectWithRetries(sessionId, result.daytonaSandboxId);
    if (adopted) {
      return adopted;
    }
    // Winner's sandbox vanished — clear and claim ours.
    await persistSandboxId(sessionId, null);
    const retry = await claimDaytonaSandboxId(sessionId, created.id);
    if (retry.claimed || retry.daytonaSandboxId === created.id) {
      return created;
    }
    if (retry.daytonaSandboxId) {
      await deleteSandboxBestEffort(sessionId, created, "lost reclaim race");
      const again = await reconnectWithRetries(sessionId, retry.daytonaSandboxId);
      if (again) {
        return again;
      }
    }
  }

  // No authoritative id — force-persist ours as last resort.
  await persistSandboxId(sessionId, created.id);
  return created;
}

async function createDaytonaSandbox(session: Session): Promise<Sandbox> {
  const daytona = getDaytonaClient();
  logDaytonaBootstrap(session.id, "sandbox", "ensuring shared volume");
  const volume = await ensureSharedVolume();

  const volumeSubpath =
    session.volumeSubpath ??
    (await import("./volume-paths")).getVolumeSubpath(
      session.id,
      session.userId,
    );

  const idleMinutes = Number(process.env.DAYTONA_SANDBOX_IDLE_MINUTES ?? 30);

  const snapshot = getDaytonaSnapshotName();
  const baseParams = {
    language: "typescript" as const,
    labels: {
      "baby-lovable-session": session.id,
    },
    autoStopInterval: idleMinutes > 0 ? idleMinutes : 0,
    volumes: [
      {
        volumeId: volume.id,
        mountPath: DAYTONA_VOLUME_MOUNT,
        subpath: volumeSubpath,
      },
    ],
  };

  logDaytonaBootstrap(
    session.id,
    "sandbox",
    snapshot
      ? `creating sandbox from snapshot=${snapshot} (volume subpath=${volumeSubpath})`
      : `creating sandbox (volume subpath=${volumeSubpath})`,
  );

  let sandbox: Sandbox;
  try {
    sandbox = await daytona.create(
      snapshot ? { ...baseParams, snapshot } : baseParams,
      { timeout: 180 },
    );
  } catch (error) {
    if (!snapshot) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    logDaytonaBootstrap(
      session.id,
      "sandbox",
      `snapshot ${snapshot} unavailable (${detail.slice(0, 200)}) — falling back to default image`,
    );
    sandbox = await daytona.create(baseParams, { timeout: 180 });
  }

  await sandbox.waitUntilStarted(180);
  logDaytonaBootstrap(session.id, "sandbox", `sandbox started ${sandbox.id}`);

  if (!session.volumeSubpath) {
    await updateSession(session.id, { volumeSubpath });
  }

  // Do NOT persist sandbox id here — claimOrAdoptSandbox owns that.
  return sandbox;
}

async function ensureManagedSandbox(
  session: Session,
): Promise<DaytonaProjectSandbox> {
  // Always re-read session so we honor the authoritative daytonaSandboxId
  // written by another Vercel isolate (agent step vs preview poll).
  const fresh = await getSession(session.id);
  if (fresh) {
    session = fresh;
  }

  const cached = managed.get(session.id);
  if (cached) {
    const authoritativeId = session.daytonaSandboxId;
    if (!authoritativeId || cached.sandbox.id === authoritativeId) {
      touchActivity(session.id);
      logDaytonaBootstrap(session.id, "sandbox", "reusing in-process sandbox cache");
      return cached.projectSandbox;
    }

    logDaytonaBootstrap(
      session.id,
      "sandbox",
      `dropping stale cache ${cached.sandbox.id} — session points to ${authoritativeId}`,
    );
    dropManagedEntry(session.id);
  }

  let sandbox: Sandbox | null = null;

  if (session.daytonaSandboxId) {
    sandbox = await reconnectWithRetries(session.id, session.daytonaSandboxId);
    if (!sandbox) {
      // Dead id — clear so CAS claim can succeed for the replacement.
      await persistSandboxId(session.id, null);
      session = (await getSession(session.id)) ?? session;
    }
  }

  // Another isolate may have claimed while we were reconnecting.
  if (!sandbox) {
    const latest = await getSession(session.id);
    if (latest?.daytonaSandboxId) {
      sandbox = await reconnectWithRetries(session.id, latest.daytonaSandboxId);
      if (sandbox) {
        session = latest;
      }
    }
  }

  if (!sandbox) {
    const created = await createDaytonaSandbox(session);
    sandbox = await claimOrAdoptSandbox(session.id, created);
  }

  const projectSandbox = new DaytonaProjectSandbox(session.id, sandbox);
  await ensureDaytonaWorkspace(projectSandbox, session);

  managed.set(session.id, {
    sandbox,
    projectSandbox,
    lastActivity: Date.now(),
  });

  return projectSandbox;
}

export async function getOrCreateDaytonaSandbox(
  sessionId: string,
): Promise<DaytonaProjectSandbox> {
  const pending = ensurePromises.get(sessionId);
  if (pending) {
    return pending;
  }

  const promise = (async () => {
    const session = await getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.sandboxMode !== "daytona") {
      throw new Error(`Session ${sessionId} is not in daytona mode`);
    }
    return ensureManagedSandbox(session);
  })();

  ensurePromises.set(sessionId, promise);
  try {
    return await promise;
  } finally {
    ensurePromises.delete(sessionId);
  }
}

export function getManagedDaytonaSandbox(
  sessionId: string,
): DaytonaProjectSandbox | null {
  return managed.get(sessionId)?.projectSandbox ?? null;
}

export function getManagedDaytonaSdkSandbox(sessionId: string): Sandbox | null {
  return managed.get(sessionId)?.sandbox ?? null;
}

/** Drop in-process sandbox cache without destroying the remote sandbox. */
export function dropManagedSandboxCache(sessionId: string): void {
  if (managed.has(sessionId)) {
    logDaytonaBootstrap(sessionId, "sandbox", "dropping in-process sandbox cache");
    managed.delete(sessionId);
  }
}

export async function destroyDaytonaSandbox(
  sessionId: string,
): Promise<void> {
  const entry = managed.get(sessionId);
  if (!entry) {
    await persistSandboxId(sessionId, null);
    await clearPreviewMemory(sessionId);
    return;
  }

  try {
    await commitWorkspaceTurn(entry.projectSandbox, {
      turnIndex: 0,
      userPrompt: "",
      messageOverride: "checkpoint: sandbox destroy",
    });
    await persistDaytonaWorkspaceToVolume(entry.projectSandbox);
  } catch {
    // Best-effort checkpoint before teardown.
  }

  try {
    await entry.sandbox.delete(60);
  } catch {
    // Sandbox may already be gone.
  }

  dropManagedEntry(sessionId);
  await persistSandboxId(sessionId, null);
}
