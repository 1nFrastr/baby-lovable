import fs from "node:fs/promises";
import path from "node:path";

import { generateId, type UIMessage } from "ai";

import { resolveSessionRoot } from "@/lib/sandbox/paths";

export interface SessionDraft {
  runId: string;
  message: UIMessage;
  updatedAt: string;
}

function getDraftFilePath(
  sessionId: string,
  userId: string | null = null,
): string {
  return path.join(resolveSessionRoot(sessionId, userId), "draft.json");
}

export function createEmptyDraft(runId: string): SessionDraft {
  return {
    runId,
    message: {
      id: generateId(),
      role: "assistant",
      parts: [],
    },
    updatedAt: new Date().toISOString(),
  };
}

export async function readDraft(
  sessionId: string,
  userId: string | null = null,
): Promise<SessionDraft | null> {
  try {
    const raw = await fs.readFile(getDraftFilePath(sessionId, userId), "utf8");
    return JSON.parse(raw) as SessionDraft;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** Atomic overwrite — safe for high-frequency streaming updates. */
export async function writeDraft(
  sessionId: string,
  draft: SessionDraft,
  userId: string | null = null,
): Promise<void> {
  const filePath = getDraftFilePath(sessionId, userId);
  const tmpPath = `${filePath}.tmp`;
  const sessionRoot = resolveSessionRoot(sessionId, userId);

  await fs.mkdir(sessionRoot, { recursive: true });
  await fs.writeFile(tmpPath, JSON.stringify(draft, null, 2), "utf8");
  await fs.rename(tmpPath, filePath);
}

export async function deleteDraft(
  sessionId: string,
  userId: string | null = null,
): Promise<void> {
  try {
    await fs.unlink(getDraftFilePath(sessionId, userId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}
