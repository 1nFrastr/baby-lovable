import type { ProjectSandbox } from "../types";

const attachBySession = new Map<string, Promise<ProjectSandbox>>();

export function getVercelFsAttach(
  sessionId: string,
): Promise<ProjectSandbox> | undefined {
  return attachBySession.get(sessionId);
}

export function setVercelFsAttach(
  sessionId: string,
  promise: Promise<ProjectSandbox>,
): void {
  attachBySession.set(sessionId, promise);
}

export function clearVercelAttachCache(sessionId?: string): void {
  if (sessionId) {
    attachBySession.delete(sessionId);
    return;
  }
  attachBySession.clear();
}
