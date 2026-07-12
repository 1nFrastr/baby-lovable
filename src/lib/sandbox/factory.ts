import { DaytonaProjectSandbox } from "./daytona-provider";
import { ensureWorkspace, LocalProjectSandbox } from "./local-provider";
import type { ProjectSandbox, SandboxMode } from "./types";

export async function createSandbox(
  sessionId: string,
  mode: SandboxMode = "local",
): Promise<ProjectSandbox> {
  if (mode === "daytona") {
    return new DaytonaProjectSandbox(sessionId);
  }

  await ensureWorkspace(sessionId);
  return new LocalProjectSandbox(sessionId);
}
