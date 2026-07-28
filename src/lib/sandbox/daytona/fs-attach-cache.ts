/**
 * Process-local FS attach cache.
 * Parallel tool steps in one isolate share one reconnect; sequential tools reuse it.
 * Must be invalidated when durable sandboxId changes (console delete / recreate).
 */
import type { DaytonaProjectSandbox } from "./provider";

const attachBySession = new Map<string, Promise<DaytonaProjectSandbox>>();

export function getFsAttach(
  sessionId: string,
): Promise<DaytonaProjectSandbox> | undefined {
  return attachBySession.get(sessionId);
}

export function setFsAttach(
  sessionId: string,
  promise: Promise<DaytonaProjectSandbox>,
): void {
  attachBySession.set(sessionId, promise);
}

export function clearDaytonaAttachCache(sessionId: string): void {
  attachBySession.delete(sessionId);
}
