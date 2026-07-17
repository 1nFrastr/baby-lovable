/** Sandbox layer: getExisting / getOrCreate / delete / status. */
import type { Session } from "@/lib/session/types";
import { getSession } from "@/lib/session/store";

import { getDaytonaClient } from "./client";
import { ensureDaytonaWorkspace } from "./workspace-bootstrap";
import { commitWorkspaceTurn } from "../workspace-git";
import type { SandboxStatus } from "../preview-types";
import type { DaytonaProjectSandbox } from "./provider";
import { clearSignedPreviewStore } from "@/lib/session/signed-preview-store";
import {
  createSandbox,
  persistSandboxId,
  reconnectSandbox,
  wrapSandbox,
} from "./vm";

/** In-flight ensure only — cleared when the promise settles. */
const ensurePromises = new Map<string, Promise<DaytonaProjectSandbox>>();

function mapSdkState(state: string | undefined): SandboxStatus {
  switch (state) {
    case "started":
      return "running";
    case "starting":
    case "restoring":
    case "pulling_image":
      return "starting";
    case "stopped":
    case "stopping":
    case "archived":
    case "archiving":
      return "stopped";
    case "error":
    case "build_failed":
      return "error";
    default:
      return state ? "stopped" : "missing";
  }
}

/** Read-only — never starts or creates. */
export async function getDaytonaSandboxStatus(
  sessionId: string,
): Promise<SandboxStatus> {
  const session = await getSession(sessionId);
  if (!session?.daytonaSandboxId || session.sandboxMode !== "daytona") {
    return "missing";
  }

  try {
    const sandbox = await getDaytonaClient().get(session.daytonaSandboxId);
    return mapSdkState(sandbox.state);
  } catch {
    return "missing";
  }
}

/**
 * Reconnect to session.daytonaSandboxId — never create.
 * wake=false: do not start stopped VMs.
 */
export async function getExistingDaytonaSandbox(
  sessionId: string,
  options?: { wake?: boolean },
): Promise<DaytonaProjectSandbox | null> {
  const wake = options?.wake ?? false;
  const session = await getSession(sessionId);
  if (!session?.daytonaSandboxId || session.sandboxMode !== "daytona") {
    return null;
  }

  const sandbox = await reconnectSandbox(
    sessionId,
    session.daytonaSandboxId,
    wake,
  );
  if (!sandbox) {
    return null;
  }

  const project = wrapSandbox(sessionId, sandbox);
  if (wake) {
    await ensureDaytonaWorkspace(project, session);
  }
  return project;
}

async function ensureSandbox(session: Session): Promise<DaytonaProjectSandbox> {
  session = (await getSession(session.id)) ?? session;

  let sandbox = session.daytonaSandboxId
    ? await reconnectSandbox(session.id, session.daytonaSandboxId, true)
    : null;

  if (!sandbox && session.daytonaSandboxId) {
    await persistSandboxId(session.id, null);
    session = (await getSession(session.id)) ?? session;
  }

  if (!sandbox) {
    sandbox = await createSandbox(session);
  }

  const project = wrapSandbox(session.id, sandbox);
  await ensureDaytonaWorkspace(project, session);
  return project;
}

/** Reconnect or create. Agent turn / POST start only. */
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
    return ensureSandbox(session);
  })();

  ensurePromises.set(sessionId, promise);
  try {
    return await promise;
  } finally {
    ensurePromises.delete(sessionId);
  }
}

export async function deleteDaytonaSandbox(sessionId: string): Promise<void> {
  await clearSignedPreviewStore(sessionId);

  const session = await getSession(sessionId);
  const sandboxId = session?.daytonaSandboxId;
  if (!sandboxId) {
    return;
  }

  const project = await getExistingDaytonaSandbox(sessionId, { wake: true });

  if (project) {
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
    try {
      await (await getDaytonaClient().get(sandboxId)).delete(60);
    } catch {
      // already gone
    }
  }

  await persistSandboxId(sessionId, null);
}
