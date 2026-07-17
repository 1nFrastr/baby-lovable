import {
  deleteDaytonaSandbox,
  getOrCreateDaytonaSandbox,
} from "./daytona/sandbox";
import { ensureWorkspace } from "./local/sandbox";
import { LocalProjectSandbox } from "./local/provider";
import type { ProjectSandbox, SandboxMode } from "./types";

export async function getProjectSandbox(
  sessionId: string,
  mode: SandboxMode,
  userId: string | null = null,
): Promise<ProjectSandbox> {
  if (mode === "daytona") {
    return getOrCreateDaytonaSandbox(sessionId);
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
