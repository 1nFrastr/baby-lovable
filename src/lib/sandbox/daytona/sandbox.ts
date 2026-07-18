/** Sandbox layer shim: getExisting / getOrCreate / delete / status → reconciler. */
import type { SandboxStatus } from "../preview-types";
import type { DaytonaProjectSandbox } from "./provider";
import {
  deriveSandboxStatus,
  type DaytonaRuntimeSnapshot,
} from "./runtime-state";
import { ensureDesiredState, readRuntime } from "./runtime-reconciler";
import { getRuntimeSnapshot } from "./runtime-store";
import { ensureDaytonaWorkspace } from "./workspace-bootstrap";
import { getSession, updateSession } from "@/lib/session/store";
import { reconnectSandbox, wrapSandbox } from "./vm";
import { getDaytonaClient } from "./client";

/** In-flight ensure — process-local coalescing only (lease is source of truth). */
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

async function sandboxIdFromRuntime(
  sessionId: string,
): Promise<string | null> {
  const snapshot = await getRuntimeSnapshot(sessionId);
  return snapshot.sandboxId;
}

/** Read-only — never starts or creates. */
export async function getDaytonaSandboxStatus(
  sessionId: string,
): Promise<SandboxStatus> {
  const snapshot = await readRuntime(sessionId);
  if (!snapshot.sandboxId) {
    return "missing";
  }

  // Prefer live SDK peek when we have an id (read path already soft-observed).
  try {
    const sandbox = await getDaytonaClient().get(snapshot.sandboxId);
    return mapSdkState(sandbox.state);
  } catch {
    return deriveSandboxStatus(snapshot);
  }
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

  const sandboxId = await sandboxIdFromRuntime(sessionId);
  if (!sandboxId) {
    return null;
  }

  const sandbox = await reconnectSandbox(sessionId, sandboxId, wake);
  if (!sandbox) {
    return null;
  }

  const project = wrapSandbox(sessionId, sandbox);
  if (wake) {
    const result = await ensureDaytonaWorkspace(project, session);
    if (result.gitInitSha) {
      await updateSession(sessionId, { lastCommitSha: result.gitInitSha });
    }
  }
  return project;
}

async function attachAfterEnsure(
  sessionId: string,
  snapshot: DaytonaRuntimeSnapshot,
): Promise<DaytonaProjectSandbox> {
  if (!snapshot.sandboxId) {
    throw new Error(`Daytona sandbox not ready for ${sessionId}`);
  }
  const project = await getExistingDaytonaSandbox(sessionId, { wake: true });
  if (!project) {
    throw new Error(`Failed to attach Daytona sandbox ${snapshot.sandboxId}`);
  }
  return project;
}

/** Reconnect or create via reconciler. Agent turn / POST start only. */
export async function getOrCreateDaytonaSandbox(
  sessionId: string,
): Promise<DaytonaProjectSandbox> {
  const pending = ensurePromises.get(sessionId);
  if (pending) {
    return pending;
  }

  const promise = (async () => {
    const snapshot = await ensureDesiredState(sessionId, "sandbox-ready", {
      wait: true,
    });
    return attachAfterEnsure(sessionId, snapshot);
  })();

  ensurePromises.set(sessionId, promise);
  try {
    return await promise;
  } finally {
    ensurePromises.delete(sessionId);
  }
}

export async function deleteDaytonaSandbox(sessionId: string): Promise<void> {
  await ensureDesiredState(sessionId, "deleted", { wait: true });
}
