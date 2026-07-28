import fs from "node:fs/promises";
import path from "node:path";

import { resolveSessionRoot } from "@/lib/sandbox/paths";

import {
  emptyGitRepository,
  type SessionGitRepository,
} from "./types";

function getRepoFilePath(
  sessionId: string,
  userId: string | null = null,
): string {
  return path.join(resolveSessionRoot(sessionId, userId), "git-repository.json");
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

export async function readGitRepositoryLocal(
  sessionId: string,
  userId: string | null = null,
): Promise<SessionGitRepository | null> {
  try {
    const raw = await fs.readFile(getRepoFilePath(sessionId, userId), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRepo(parsed) || parsed.sessionId !== sessionId) {
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

export async function writeGitRepositoryLocal(
  repo: SessionGitRepository,
  userId: string | null = null,
): Promise<void> {
  const filePath = getRepoFilePath(repo.sessionId, userId);
  const tmpPath = `${filePath}.tmp`;
  const sessionRoot = resolveSessionRoot(repo.sessionId, userId);

  await fs.mkdir(sessionRoot, { recursive: true });
  await fs.writeFile(tmpPath, `${JSON.stringify(repo, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

export async function ensureGitRepositoryLocal(
  sessionId: string,
  userId: string | null = null,
): Promise<SessionGitRepository> {
  const existing = await readGitRepositoryLocal(sessionId, userId);
  if (existing) {
    return existing;
  }
  const created = emptyGitRepository(sessionId);
  created.revision = 1;
  await writeGitRepositoryLocal(created, userId);
  return created;
}
