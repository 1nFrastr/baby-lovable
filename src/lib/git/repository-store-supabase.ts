import { sanitizeJsonbValue } from "@/lib/json/sanitize-jsonb";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

import {
  emptyGitRepository,
  type SessionGitRepository,
} from "./types";

interface GitRepositoryRow {
  session_id: string;
  user_id: string;
  repository: SessionGitRepository;
  updated_at: string;
}

function isRepo(value: unknown): value is SessionGitRepository {
  if (!value || typeof value !== "object") {
    return false;
  }
  const obj = value as SessionGitRepository;
  return (
    typeof obj.sessionId === "string" &&
    typeof obj.provisionStatus === "string" &&
    typeof obj.revision === "number"
  );
}

export async function readGitRepositorySupabase(
  sessionId: string,
): Promise<SessionGitRepository | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("session_git_repositories")
    .select("repository")
    .eq("session_id", sessionId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read git repository: ${error.message}`);
  }
  if (!data) {
    return null;
  }

  const repository = (data as Pick<GitRepositoryRow, "repository">).repository;
  if (!isRepo(repository) || repository.sessionId !== sessionId) {
    return null;
  }
  return repository;
}

export async function writeGitRepositorySupabase(
  repo: SessionGitRepository,
  userId: string | null,
): Promise<void> {
  if (!userId) {
    throw new Error("userId required for Supabase git repository storage");
  }

  const supabase = getSupabaseAdminClient();
  const { error } = await supabase.from("session_git_repositories").upsert(
    {
      session_id: repo.sessionId,
      user_id: userId,
      repository: sanitizeJsonbValue(repo),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "session_id" },
  );

  if (error) {
    throw new Error(`Failed to write git repository: ${error.message}`);
  }
}

export async function ensureGitRepositorySupabase(
  sessionId: string,
  userId: string | null,
): Promise<SessionGitRepository> {
  const existing = await readGitRepositorySupabase(sessionId);
  if (existing) {
    return existing;
  }
  const created = emptyGitRepository(sessionId);
  created.revision = 1;
  await writeGitRepositorySupabase(created, userId);
  return created;
}
