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

export interface GitRepositoryStoreAdapter {
  /** Supabase requires the owning auth user; in-memory unit adapters do not. */
  requiresUserId?: boolean;
  read(sessionId: string): Promise<SessionGitRepository | null>;
  ensure(
    sessionId: string,
    userId: string | null,
  ): Promise<SessionGitRepository>;
  write(repo: SessionGitRepository, userId: string | null): Promise<void>;
}

const supabaseAdapter: GitRepositoryStoreAdapter = {
  requiresUserId: true,
  read: readGitRepositorySupabase,
  ensure: ensureGitRepositorySupabase,
  write: writeGitRepositorySupabase,
};

let storeAdapter: GitRepositoryStoreAdapter = supabaseAdapter;

/** Unit tests inject an in-memory adapter; production always uses Supabase. */
export function setGitRepositoryStoreAdapterForTests(
  adapter: GitRepositoryStoreAdapter | null,
): void {
  storeAdapter = adapter ?? supabaseAdapter;
}

async function resolveUserId(
  sessionId: string,
  userId: string | null = null,
): Promise<string | null> {
  if (userId) {
    return userId;
  }
  const { getSessionOwner } = await import("@/lib/session/store");
  const owner = await getSessionOwner(sessionId);
  return owner?.userId ?? null;
}

export async function readGitRepository(
  sessionId: string,
  userId: string | null = null,
): Promise<SessionGitRepository | null> {
  void userId;
  const repo = await storeAdapter.read(sessionId);
  return repo ? normalizeGitRepository(repo) : null;
}

export async function ensureGitRepository(
  sessionId: string,
  userId: string | null = null,
): Promise<SessionGitRepository> {
  const ownerId =
    storeAdapter.requiresUserId === false
      ? userId
      : await resolveUserId(sessionId, userId);
  const repo = await storeAdapter.ensure(sessionId, ownerId);
  return normalizeGitRepository(repo);
}

export async function writeGitRepository(
  repo: SessionGitRepository,
  userId: string | null = null,
): Promise<void> {
  const ownerId =
    storeAdapter.requiresUserId === false
      ? userId
      : await resolveUserId(repo.sessionId, userId);
  await storeAdapter.write(repo, ownerId);

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
