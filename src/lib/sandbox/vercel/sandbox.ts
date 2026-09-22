import type { ProjectSandbox } from "../types";
import { canFastAttachSandbox } from "../daytona/sandbox";
import { ensureDesiredState, markSandboxExternallyDeleted } from "../daytona/runtime-reconciler";
import { getRuntimeSnapshot } from "../daytona/runtime-store";
import { getSession } from "@/lib/session/store";
import { vercelDriver } from "./driver";
import {
  clearVercelAttachCache,
  getVercelFsAttach,
  setVercelFsAttach,
} from "./fs-attach-cache";

function kickPreviewWarmIfNeeded(sessionId: string): void {
  void ensureDesiredState(sessionId, "preview-ready", { wait: false }).catch(
    () => {
      // best-effort
    },
  );
}

async function reconnectProject(
  sessionId: string,
  sandboxId: string,
  wake: boolean,
): Promise<ProjectSandbox | null> {
  return vercelDriver.reconnect(sessionId, sandboxId, wake);
}

async function attachVercelSandboxForFsOnce(
  sessionId: string,
): Promise<ProjectSandbox> {
  const session = await getSession(sessionId);
  if (!session || session.sandboxMode !== "vercel") {
    throw new Error(`Session ${sessionId} is not a Vercel sandbox session`);
  }

  let snapshot = await getRuntimeSnapshot(sessionId, null, { fresh: true });

  if (canFastAttachSandbox(snapshot) && snapshot.sandboxId) {
    const project = await reconnectProject(sessionId, snapshot.sandboxId, true);
    if (project) {
      await vercelDriver.extendSessionIfNeeded(project);
      kickPreviewWarmIfNeeded(sessionId);
      return project;
    }
    if (!(await vercelDriver.exists(snapshot.sandboxId))) {
      await markSandboxExternallyDeleted(sessionId);
    }
  }

  snapshot = await ensureDesiredState(sessionId, "sandbox-ready", {
    wait: true,
  });
  if (!snapshot.sandboxId) {
    throw new Error(`Vercel sandbox not ready for session ${sessionId}`);
  }

  const project = await reconnectProject(sessionId, snapshot.sandboxId, true);
  if (!project) {
    throw new Error(`Failed to attach Vercel sandbox ${snapshot.sandboxId}`);
  }
  await vercelDriver.extendSessionIfNeeded(project);
  kickPreviewWarmIfNeeded(sessionId);
  return project;
}

export function attachVercelSandboxForFs(
  sessionId: string,
): Promise<ProjectSandbox> {
  const pending = getVercelFsAttach(sessionId);
  if (pending) {
    return pending;
  }

  const promise = attachVercelSandboxForFsOnce(sessionId).catch((error) => {
    if (getVercelFsAttach(sessionId) === promise) {
      clearVercelAttachCache(sessionId);
    }
    throw error;
  });

  setVercelFsAttach(sessionId, promise);
  return promise;
}

export async function getExistingVercelSandbox(
  sessionId: string,
  options?: { wake?: boolean },
): Promise<ProjectSandbox | null> {
  const wake = options?.wake ?? false;
  const session = await getSession(sessionId);
  if (!session || session.sandboxMode !== "vercel") {
    return null;
  }
  const snapshot = await getRuntimeSnapshot(sessionId);
  if (!snapshot.sandboxId) {
    return null;
  }
  return reconnectProject(sessionId, snapshot.sandboxId, wake);
}
