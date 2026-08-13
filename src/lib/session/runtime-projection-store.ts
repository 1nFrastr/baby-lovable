import {
  appTestFromLatest,
  emptyRuntimeProjection,
  mapSessionRunStatus,
  mergeRuntimeProjection,
  previewFromAllStatus,
  shouldBumpRuntimeVersion,
  type RuntimeProjectionPatch,
  type RuntimeTransport,
  type SessionRuntimeProjection,
} from "./runtime-projection";
import {
  readRuntimeProjectionSupabase,
  writeRuntimeProjectionSupabase,
} from "./runtime-projection-store-supabase";

export type { SessionRuntimeProjection, RuntimeTransport };

export function getRuntimeTransport(): RuntimeTransport {
  return "realtime";
}

async function resolveUserId(
  sessionId: string,
  userId: string | null = null,
): Promise<string | null> {
  if (userId) {
    return userId;
  }
  const { getSession } = await import("./store");
  const session = await getSession(sessionId);
  return session?.userId ?? null;
}

export async function readRuntimeProjectionStore(
  sessionId: string,
  userId: string | null = null,
): Promise<SessionRuntimeProjection | null> {
  void userId;
  return readRuntimeProjectionSupabase(sessionId);
}

export async function writeRuntimeProjectionStore(
  projection: SessionRuntimeProjection,
  userId: string | null = null,
): Promise<void> {
  const ownerId = await resolveUserId(projection.sessionId, userId);
  return writeRuntimeProjectionSupabase(projection, ownerId);
}

/**
 * Assemble projection once from domain stores and persist.
 * Subsequent reads hit the projection store only (no per-request 3-domain assemble).
 */
export async function ensureRuntimeProjection(
  sessionId: string,
  userId: string | null = null,
): Promise<SessionRuntimeProjection> {
  const ownerId = await resolveUserId(sessionId, userId);
  const existing = await readRuntimeProjectionStore(sessionId, ownerId);
  if (existing) {
    return existing;
  }

  const assembled = await assembleRuntimeProjection(sessionId);
  // First write — version starts at 1 so clients treat it as a real snapshot.
  const initial: SessionRuntimeProjection = {
    ...assembled,
    version: 1,
  };
  await writeRuntimeProjectionStore(initial, ownerId);

  return initial;
}

async function assembleRuntimeProjection(
  sessionId: string,
): Promise<SessionRuntimeProjection> {
  const now = new Date().toISOString();
  const base = emptyRuntimeProjection(sessionId, now);

  const { getSession } = await import("./store");
  const session = await getSession(sessionId);

  if (session) {
    base.run = {
      status: mapSessionRunStatus(session.runStatus),
      runId: session.lastRunId,
      updatedAt: session.updatedAt || now,
    };
  }

  try {
    // Side-effect free: never call peekAllStatus (it may kick background observe).
    const { getRuntimeSnapshot } = await import(
      "@/lib/sandbox/daytona/runtime-store"
    );
    const { deriveAllStatus } = await import(
      "@/lib/sandbox/daytona/runtime-state"
    );
    const snapshot = await getRuntimeSnapshot(sessionId);
    base.preview = previewFromAllStatus(
      deriveAllStatus(snapshot),
      snapshot.generation,
      now,
    );
  } catch (error) {
    console.warn(
      `[runtime-projection] assemble preview failed for ${sessionId}:`,
      error instanceof Error ? error.message : error,
    );
  }

  try {
    const { readLatestAppTestStatus } = await import(
      "@/lib/browser-run/run-status"
    );
    const latest = await readLatestAppTestStatus(sessionId, session?.userId);
    base.appTest = appTestFromLatest(latest, now);
  } catch (error) {
    console.warn(
      `[runtime-projection] assemble appTest failed for ${sessionId}:`,
      error instanceof Error ? error.message : error,
    );
  }

  try {
    const { readGitRepository } = await import("@/lib/git/repository-store");
    const { sourceControlFromRepository } = await import("@/lib/git/types");
    const repo = await readGitRepository(sessionId, session?.userId);
    base.sourceControl = sourceControlFromRepository(repo, now);
  } catch (error) {
    console.warn(
      `[runtime-projection] assemble sourceControl failed for ${sessionId}:`,
      error instanceof Error ? error.message : error,
    );
  }

  return base;
}

/**
 * Merge domain patch into durable projection. Bumps version only when
 * UI-visible fields change.
 *
 * Does not call ensure/assemble (avoids peekAllStatus side effects on writers).
 */
export async function publishRuntimeUpdate(
  sessionId: string,
  patch: RuntimeProjectionPatch,
  userId: string | null = null,
): Promise<SessionRuntimeProjection | null> {
  try {
    const ownerId = await resolveUserId(sessionId, userId);
    const current =
      (await readRuntimeProjectionStore(sessionId, ownerId)) ??
      emptyRuntimeProjection(sessionId);
    const merged = mergeRuntimeProjection(current, patch);

    if (current.version > 0 && !shouldBumpRuntimeVersion(current, merged)) {
      return current;
    }

    const next: SessionRuntimeProjection = {
      ...merged,
      version: current.version + 1,
    };

    await writeRuntimeProjectionStore(next, ownerId);

    return next;
  } catch (error) {
    console.warn(
      `[runtime-projection] publish failed for ${sessionId}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
