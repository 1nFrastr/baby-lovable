import { attachDaytonaSandboxForFs, deleteDaytonaSandbox } from "./daytona/sandbox";
import { attachVercelSandboxForFs } from "./vercel/sandbox";
import { assertFreestyleForDaytona } from "../git/freestyle-config";
import { getSessionOwner } from "@/lib/session/store";
import type { ProjectSandbox } from "./types";
import { getSandboxDriverForSession } from "./providers";

export async function getProjectSandbox(
  sessionId: string,
): Promise<ProjectSandbox> {
  const owner = await getSessionOwner(sessionId);
  if (!owner) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  assertFreestyleForDaytona(owner.sandboxMode);
  if (owner.sandboxMode === "vercel") {
    return attachVercelSandboxForFs(sessionId);
  }
  return attachDaytonaSandboxForFs(sessionId);
}

export async function getExistingProjectSandbox(
  sessionId: string,
  options?: { wake?: boolean },
): Promise<ProjectSandbox | null> {
  const driver = await getSandboxDriverForSession(sessionId);
  const { getRuntimeSnapshot } = await import("./daytona/runtime-store");
  const snapshot = await getRuntimeSnapshot(sessionId);
  if (!snapshot.sandboxId) {
    return null;
  }
  return driver.reconnect(sessionId, snapshot.sandboxId, options?.wake ?? false);
}

export { deleteDaytonaSandbox };
