import {
  attachDaytonaSandboxForFs,
  deleteDaytonaSandbox,
} from "./daytona/sandbox";
import { assertFreestyleForDaytona } from "../git/freestyle-config";
import type { ProjectSandbox } from "./types";

export async function getProjectSandbox(
  sessionId: string,
): Promise<ProjectSandbox> {
  assertFreestyleForDaytona();
  return attachDaytonaSandboxForFs(sessionId);
}

export async function createSandbox(
  sessionId: string,
): Promise<ProjectSandbox> {
  return getProjectSandbox(sessionId);
}

export { deleteDaytonaSandbox };
