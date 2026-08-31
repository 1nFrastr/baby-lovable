import { sanitizeJsonbValue } from "@/lib/json/sanitize-jsonb";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

import type { SessionGitSyncTask } from "./types";

interface GitSyncTaskRow {
  session_id: string;
  run_id: string;
  user_id: string;
  task: SessionGitSyncTask;
  updated_at: string;
}

function isTask(value: unknown): value is SessionGitSyncTask {
  if (!value || typeof value !== "object") {
    return false;
  }
  const obj = value as SessionGitSyncTask;
  return (
    typeof obj.sessionId === "string" &&
    typeof obj.runId === "string" &&
    typeof obj.status === "string" &&
    typeof obj.revision === "number"
  );
}

export async function readGitSyncTaskSupabase(
  sessionId: string,
  runId: string,
): Promise<SessionGitSyncTask | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("session_git_sync_tasks")
    .select("task")
    .eq("session_id", sessionId)
    .eq("run_id", runId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read git sync task: ${error.message}`);
  }
  if (!data) {
    return null;
  }

  const task = (data as Pick<GitSyncTaskRow, "task">).task;
  if (!isTask(task) || task.sessionId !== sessionId) {
    return null;
  }
  return task;
}

export async function writeGitSyncTaskSupabase(
  task: SessionGitSyncTask,
  userId: string | null,
): Promise<void> {
  if (!userId) {
    throw new Error("userId required for Supabase git sync task storage");
  }

  const supabase = getSupabaseAdminClient();
  const { error } = await supabase.from("session_git_sync_tasks").upsert(
    {
      session_id: task.sessionId,
      run_id: task.runId,
      user_id: userId,
      task: sanitizeJsonbValue(task),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "session_id,run_id" },
  );

  if (error) {
    throw new Error(`Failed to write git sync task: ${error.message}`);
  }
}

export async function listGitSyncTasksSupabase(
  sessionId: string,
): Promise<SessionGitSyncTask[]> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("session_git_sync_tasks")
    .select("task")
    .eq("session_id", sessionId);

  if (error) {
    throw new Error(`Failed to list git sync tasks: ${error.message}`);
  }

  const tasks: SessionGitSyncTask[] = [];
  for (const row of data ?? []) {
    const task = (row as Pick<GitSyncTaskRow, "task">).task;
    if (isTask(task) && task.sessionId === sessionId) {
      tasks.push(task);
    }
  }
  return tasks;
}
