import {
  deleteDaytonaSandbox,
  getExistingDaytonaSandbox,
} from "./daytona/sandbox";
import { ensureDesiredState } from "./daytona/runtime-reconciler";
import { ensureWorkspace } from "./local/sandbox";
import { LocalProjectSandbox } from "./local/provider";
import type { ProjectSandbox, SandboxMode } from "./types";

export async function getProjectSandbox(
  sessionId: string,
  mode: SandboxMode,
  userId: string | null = null,
): Promise<ProjectSandbox> {
  if (mode === "daytona") {
    await ensureDesiredState(sessionId, "sandbox-ready", { wait: true });
    const sandbox = await getExistingDaytonaSandbox(sessionId, { wake: true });
    if (!sandbox) {
      throw new Error(`Daytona sandbox not ready for session ${sessionId}`);
    }
    return sandbox;
  }

  await ensureWorkspace(sessionId, userId);
  return new LocalProjectSandbox(sessionId);
}

export async function createSandbox(
  sessionId: string,
  mode: SandboxMode = "local",
  userId: string | null = null,
): Promise<ProjectSandbox> {
  return getProjectSandbox(sessionId, mode, userId);
}

export { deleteDaytonaSandbox };
