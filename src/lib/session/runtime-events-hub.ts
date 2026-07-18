import type { SessionRuntimeProjection } from "./runtime-projection";

type RuntimeListener = (projection: SessionRuntimeProjection) => void;

/**
 * In-process fanout for file-store SSE (`GET /events`).
 * Not used when persist backend is Supabase (Realtime owns push).
 */
const listeners = new Map<string, Set<RuntimeListener>>();

export function subscribeRuntimeEvents(
  sessionId: string,
  listener: RuntimeListener,
): () => void {
  let set = listeners.get(sessionId);
  if (!set) {
    set = new Set();
    listeners.set(sessionId, set);
  }
  set.add(listener);

  return () => {
    const current = listeners.get(sessionId);
    if (!current) {
      return;
    }
    current.delete(listener);
    if (current.size === 0) {
      listeners.delete(sessionId);
    }
  };
}

export function notifyRuntimeEvents(
  projection: SessionRuntimeProjection,
): void {
  const set = listeners.get(projection.sessionId);
  if (!set || set.size === 0) {
    return;
  }
  for (const listener of set) {
    try {
      listener(projection);
    } catch (error) {
      console.warn(
        `[runtime-events] listener failed for ${projection.sessionId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}
