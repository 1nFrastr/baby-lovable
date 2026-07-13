import type { Session } from "@/lib/session/types";
import { getSession, updateSession } from "@/lib/session/store";

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
  } catch {
    logDaytonaBootstrap(sessionId, "sandbox", `sandbox ${sandboxId} unavailable — will create new`);
    return null;
  }
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

  await persistSandboxId(session.id, sandbox.id);
  return sandbox;
}

async function ensureManagedSandbox(
  session: Session,
): Promise<DaytonaProjectSandbox> {
  const cached = managed.get(session.id);
  if (cached) {
    touchActivity(session.id);
    logDaytonaBootstrap(session.id, "sandbox", "reusing in-process sandbox cache");
    return cached.projectSandbox;
  }

  let sandbox: Sandbox | null = null;

  if (session.daytonaSandboxId) {
    sandbox = await tryGetExistingSandbox(session.id, session.daytonaSandboxId);
  }

  if (!sandbox) {
    sandbox = await createDaytonaSandbox(session);
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

export async function destroyDaytonaSandbox(
  sessionId: string,
): Promise<void> {
  const entry = managed.get(sessionId);
  if (!entry) {
    await persistSandboxId(sessionId, null);
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

  managed.delete(sessionId);
  await persistSandboxId(sessionId, null);
}
