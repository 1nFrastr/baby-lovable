import fs from "node:fs/promises";
import path from "node:path";

import type { UIMessage } from "ai";

import { ensureWorkspace } from "@/lib/sandbox/local-provider";
import { getSessionRoot } from "@/lib/sandbox/paths";

import type {
  CreateSessionInput,
  Session,
  SessionSummary,
  UpdateSessionInput,
} from "./types";

function createSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `sess_${timestamp}${random}`;
}

function getSessionFilePath(sessionId: string): string {
  return path.join(getSessionRoot(sessionId), "session.json");
}

async function readSessionFile(sessionId: string): Promise<Session | null> {
  try {
    const raw = await fs.readFile(getSessionFilePath(sessionId), "utf8");
    return JSON.parse(raw) as Session;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeSessionFile(session: Session): Promise<void> {
  const sessionRoot = getSessionRoot(session.id);
  await fs.mkdir(sessionRoot, { recursive: true });
  await fs.writeFile(
    getSessionFilePath(session.id),
    JSON.stringify(session, null, 2),
    "utf8",
  );
}

export async function createSession(
  input: CreateSessionInput = {},
): Promise<Session> {
  const now = new Date().toISOString();
  const session: Session = {
    id: createSessionId(),
    title: input.title ?? "New Project",
    createdAt: now,
    updatedAt: now,
    messages: [],
    sandboxMode: input.sandboxMode ?? "local",
  };

  await ensureWorkspace(session.id);
  await writeSessionFile(session);
  return session;
}

export async function getSession(sessionId: string): Promise<Session | null> {
  return readSessionFile(sessionId);
}

export async function listSessions(): Promise<SessionSummary[]> {
  const sessionsRoot = path.join(process.cwd(), ".baby-lovable", "sessions");

  try {
    const entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => readSessionFile(entry.name)),
    );

    return sessions
      .filter((session): session is Session => session !== null)
      .map(({ id, title, createdAt, updatedAt, lastRunId, sandboxMode }) => ({
        id,
        title,
        createdAt,
        updatedAt,
        lastRunId,
        sandboxMode,
      }))
      .sort(
        (left, right) =>
          new Date(right.updatedAt).getTime() -
          new Date(left.updatedAt).getTime(),
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function updateSession(
  sessionId: string,
  input: UpdateSessionInput,
): Promise<Session> {
  const existing = await getSession(sessionId);
  if (!existing) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const updated: Session = {
    ...existing,
    ...input,
    updatedAt: new Date().toISOString(),
  };

  await writeSessionFile(updated);
  return updated;
}

export async function appendMessages(
  sessionId: string,
  messages: UIMessage[],
): Promise<Session> {
  return updateSession(sessionId, { messages });
}

export function deriveSessionTitle(messages: UIMessage[]): string | undefined {
  const firstUserMessage = messages.find((message) => message.role === "user");
  if (!firstUserMessage) {
    return undefined;
  }

  const textPart = firstUserMessage.parts.find((part) => part.type === "text");
  if (!textPart || textPart.type !== "text") {
    return undefined;
  }

  const trimmed = textPart.text.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
}
