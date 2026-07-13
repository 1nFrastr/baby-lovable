import fs from "node:fs/promises";
import path from "node:path";

import type { UIMessage } from "ai";

import { ensureWorkspace } from "@/lib/sandbox/local-provider";
import { getVolumeSubpath } from "@/lib/sandbox/daytona/volume-paths";
import {
  getSessionsRoot,
  resolveSessionRoot,
} from "@/lib/sandbox/paths";
import { getDefaultSandboxMode } from "@/lib/sandbox/types";

import {
  assertSessionOwner,
  type SessionAuthContext,
} from "./auth-context";
import type {
  CreateSessionInput,
  Session,
  SessionSummary,
  UpdateSessionInput,
} from "./types";
import { SESSION_SCHEMA_VERSION } from "./types";

function createSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `sess_${timestamp}${random}`;
}

function getSessionFilePath(
  sessionId: string,
  userId: string | null = null,
): string {
  return path.join(resolveSessionRoot(sessionId, userId), "session.json");
}

async function readSessionFile(
  sessionId: string,
  userId: string | null = null,
): Promise<Session | null> {
  try {
    const raw = await fs.readFile(getSessionFilePath(sessionId, userId), "utf8");
    return JSON.parse(raw) as Session;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeSessionFile(session: Session): Promise<void> {
  const sessionRoot = resolveSessionRoot(session.id, session.userId);
  await fs.mkdir(sessionRoot, { recursive: true });
  if (session.sandboxMode === "local") {
    await ensureWorkspace(session.id, session.userId);
  }
  await fs.writeFile(
    getSessionFilePath(session.id, session.userId),
    JSON.stringify(session, null, 2),
    "utf8",
  );
}

function toSummary(session: Session): SessionSummary {
  return {
    id: session.id,
    userId: session.userId,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastRunId: session.lastRunId,
    runStatus: session.runStatus,
    sandboxMode: session.sandboxMode,
    messageCount: session.messages.length,
  };
}

function filterByAuth(
  sessions: Session[],
  auth: SessionAuthContext,
): Session[] {
  return sessions.filter((session) => {
    if (session.deletedAt) {
      return false;
    }

    try {
      assertSessionOwner(session.userId, auth);
      return true;
    } catch {
      return false;
    }
  });
}

export async function createSessionLocal(
  input: CreateSessionInput = {},
  auth: SessionAuthContext = { userId: null },
): Promise<Session> {
  const now = new Date().toISOString();
  const userId = input.userId ?? auth.userId;

  const session: Session = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: createSessionId(),
    userId,
    title: input.title ?? "New Project",
    createdAt: now,
    updatedAt: now,
    messages: [],
    runStatus: "idle",
    sandboxMode: input.sandboxMode ?? getDefaultSandboxMode(),
    deletedAt: null,
  };

  if (session.sandboxMode === "daytona") {
    session.volumeSubpath = getVolumeSubpath(session.id, session.userId);
  } else {
    await ensureWorkspace(session.id, session.userId);
  }

  await writeSessionFile(session);
  return session;
}

export async function getSessionLocal(
  sessionId: string,
  auth: SessionAuthContext = { userId: null },
): Promise<Session | null> {
  const session = await readSessionFile(sessionId, auth.userId);
  if (!session || session.deletedAt) {
    return null;
  }

  assertSessionOwner(session.userId, auth);
  return session;
}

export async function listSessionsLocal(
  auth: SessionAuthContext = { userId: null },
): Promise<SessionSummary[]> {
  const sessionsRoot = getSessionsRoot(auth.userId);

  try {
    const entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => readSessionFile(entry.name, auth.userId)),
    );

    return filterByAuth(
      sessions.filter((session): session is Session => session !== null),
      auth,
    )
      .map(toSummary)
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

export async function updateSessionLocal(
  sessionId: string,
  input: UpdateSessionInput,
  auth: SessionAuthContext = { userId: null },
): Promise<Session> {
  const existing = await getSessionLocal(sessionId, auth);
  if (!existing) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const { lastRunId, daytonaSandboxId, ...rest } = input;

  const updated: Session = {
    ...existing,
    ...rest,
    schemaVersion: SESSION_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
  };

  if (lastRunId === null) {
    delete updated.lastRunId;
  } else if (lastRunId !== undefined) {
    updated.lastRunId = lastRunId;
  }

  if (daytonaSandboxId === null) {
    delete updated.daytonaSandboxId;
  } else if (daytonaSandboxId !== undefined) {
    updated.daytonaSandboxId = daytonaSandboxId;
  }

  await writeSessionFile(updated);
  return updated;
}

export async function replaceMessagesLocal(
  sessionId: string,
  messages: UIMessage[],
  auth: SessionAuthContext = { userId: null },
): Promise<Session> {
  return updateSessionLocal(sessionId, { messages }, auth);
}

/**
 * Claim `daytonaSandboxId` when unset (best-effort CAS for local file store).
 */
export async function claimDaytonaSandboxIdLocal(
  sessionId: string,
  sandboxId: string,
  auth: SessionAuthContext = { userId: null },
): Promise<{ claimed: boolean; daytonaSandboxId: string | null }> {
  const existing = await getSessionLocal(sessionId, auth);
  if (!existing) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  if (existing.daytonaSandboxId === sandboxId) {
    return { claimed: true, daytonaSandboxId: sandboxId };
  }
  if (existing.daytonaSandboxId) {
    return {
      claimed: false,
      daytonaSandboxId: existing.daytonaSandboxId,
    };
  }

  await updateSessionLocal(sessionId, { daytonaSandboxId: sandboxId }, auth);

  const fresh = await getSessionLocal(sessionId, auth);
  return {
    claimed: fresh?.daytonaSandboxId === sandboxId,
    daytonaSandboxId: fresh?.daytonaSandboxId ?? null,
  };
}
