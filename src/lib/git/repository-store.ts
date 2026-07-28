import { isLocalFileStorageMode } from "@/lib/supabase/config";

import {
  ensureGitRepositoryLocal,
  readGitRepositoryLocal,
  writeGitRepositoryLocal,
} from "./repository-store-local";
import {
  ensureGitRepositorySupabase,
  readGitRepositorySupabase,
  writeGitRepositorySupabase,
} from "./repository-store-supabase";
import {
  normalizeGitRepository,
  sourceControlFromRepository,
  type SessionGitRepository,
} from "./types";

async function resolveUserId(
  sessionId: string,
  userId: string | null = null,
): Promise<string | null> {
  if (userId) {
    return userId;
  }
  const { getSession } = await import("@/lib/session/store");
  const session = await getSession(sessionId);
  return session?.userId ?? null;
}

export async function readGitRepository(
  sessionId: string,
  userId: string | null = null,
): Promise<SessionGitRepository | null> {
  const repo = !isLocalFileStorageMode()
    ? await readGitRepositorySupabase(sessionId)
    : await readGitRepositoryLocal(sessionId, userId);
  return repo ? normalizeGitRepository(repo) : null;
}

export async function ensureGitRepository(
  sessionId: string,
  userId: string | null = null,
): Promise<SessionGitRepository> {
  const ownerId = await resolveUserId(sessionId, userId);
  const repo = !isLocalFileStorageMode()
    ? await ensureGitRepositorySupabase(sessionId, ownerId)
    : await ensureGitRepositoryLocal(sessionId, ownerId);
  return normalizeGitRepository(repo);
}

export async function writeGitRepository(
  repo: SessionGitRepository,
  userId: string | null = null,
): Promise<void> {
  const ownerId = await resolveUserId(repo.sessionId, userId);
  if (!isLocalFileStorageMode()) {
    await writeGitRepositorySupabase(repo, ownerId);
  } else {
    await writeGitRepositoryLocal(repo, ownerId);
  }

  try {
    const { publishRuntimeUpdate } = await import(
      "@/lib/session/runtime-projection-store"
    );
    await publishRuntimeUpdate(
      repo.sessionId,
      { sourceControl: sourceControlFromRepository(repo) },
      ownerId,
    );
  } catch {
    // Projection is best-effort.
  }
}

export class GitRepositoryCasError extends Error {
  constructor(message = "git repository CAS conflict") {
    super(message);
    this.name = "GitRepositoryCasError";
  }
}

/** Compare-and-swap update by revision. */
export async function updateGitRepository(
  sessionId: string,
  expectedRevision: number,
  patch: Partial<SessionGitRepository>,
  userId: string | null = null,
): Promise<SessionGitRepository> {
  const current = await ensureGitRepository(sessionId, userId);
  if (current.revision !== expectedRevision) {
    throw new GitRepositoryCasError(
      `expected revision ${expectedRevision}, found ${current.revision}`,
    );
  }

  const next: SessionGitRepository = {
    ...current,
    ...patch,
    sessionId,
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  await writeGitRepository(next, userId);
  return next;
}

export async function updateGitRepositoryWithRetry(
  sessionId: string,
  mutate: (
    current: SessionGitRepository,
  ) => Partial<SessionGitRepository> | null,
  userId: string | null = null,
  attempts = 5,
): Promise<SessionGitRepository> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    const current = await ensureGitRepository(sessionId, userId);
    const patch = mutate(current);
    if (!patch) {
      return current;
    }
    try {
      return await updateGitRepository(
        sessionId,
        current.revision,
        patch,
        userId,
      );
    } catch (error) {
      lastError = error;
      if (!(error instanceof GitRepositoryCasError)) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("git repository update retry exhausted");
}
