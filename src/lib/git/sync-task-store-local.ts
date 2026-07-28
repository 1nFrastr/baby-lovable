import fs from "node:fs/promises";
import path from "node:path";

import { resolveSessionRoot } from "@/lib/sandbox/paths";

import type { SessionGitSyncTask } from "./types";

function getTasksDir(
  sessionId: string,
  userId: string | null = null,
): string {
  return path.join(resolveSessionRoot(sessionId, userId), "git-sync-tasks");
}

function getTaskFilePath(
  sessionId: string,
  runId: string,
  userId: string | null = null,
): string {
  const safeRunId = runId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(getTasksDir(sessionId, userId), `${safeRunId}.json`);
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

export async function readGitSyncTaskLocal(
  sessionId: string,
  runId: string,
  userId: string | null = null,
): Promise<SessionGitSyncTask | null> {
  try {
    const raw = await fs.readFile(
      getTaskFilePath(sessionId, runId, userId),
      "utf8",
    );
    const parsed = JSON.parse(raw) as unknown;
    if (!isTask(parsed) || parsed.sessionId !== sessionId) {
      return null;
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeGitSyncTaskLocal(
  task: SessionGitSyncTask,
  userId: string | null = null,
): Promise<void> {
  const dir = getTasksDir(task.sessionId, userId);
  const filePath = getTaskFilePath(task.sessionId, task.runId, userId);
  const tmpPath = `${filePath}.tmp`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmpPath, `${JSON.stringify(task, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

export async function listGitSyncTasksLocal(
  sessionId: string,
  userId: string | null = null,
): Promise<SessionGitSyncTask[]> {
  const dir = getTasksDir(sessionId, userId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const tasks: SessionGitSyncTask[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    try {
      const raw = await fs.readFile(path.join(dir, entry), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (isTask(parsed) && parsed.sessionId === sessionId) {
        tasks.push(parsed);
      }
    } catch {
      // skip corrupt
    }
  }
  return tasks;
}
