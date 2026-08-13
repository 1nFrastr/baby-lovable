import type { UIMessage } from "ai";

import {
  type SessionAuthContext,
} from "./auth-context";
import {
  createSessionSupabase,
  getSessionSupabase,
  listSessionsSupabase,
  replaceMessagesSupabase,
  updateSessionSupabase,
} from "./store-supabase";
import type {
  CreateSessionInput,
  Session,
  SessionSummary,
  UpdateSessionInput,
} from "./types";

export async function createSession(
  input: CreateSessionInput = {},
  auth: SessionAuthContext = { userId: null },
): Promise<Session> {
  return createSessionSupabase(input, auth);
}

export async function getSession(
  sessionId: string,
  auth: SessionAuthContext = { userId: null },
): Promise<Session | null> {
  return getSessionSupabase(sessionId, auth);
}

export async function listSessions(
  auth: SessionAuthContext = { userId: null },
): Promise<SessionSummary[]> {
  return listSessionsSupabase(auth);
}

export async function updateSession(
  sessionId: string,
  input: UpdateSessionInput,
  auth: SessionAuthContext = { userId: null },
): Promise<Session> {
  const session = await updateSessionSupabase(sessionId, input, auth);

  if (input.runStatus !== undefined || input.lastRunId !== undefined) {
    // Await so Realtime clients see terminal runStatus before post-turn
    // work (e.g. git) continues — otherwise the composer stays locked on a
    // stale "running" projection while useChat drains the workflow stream.
    await publishRunRuntime(session);
  }

  return session;
}

async function publishRunRuntime(session: Session): Promise<void> {
  try {
    const { mapSessionRunStatus } = await import("./runtime-projection");
    const { publishRuntimeUpdate } = await import("./runtime-projection-store");
    await publishRuntimeUpdate(
      session.id,
      {
        run: {
          status: mapSessionRunStatus(session.runStatus),
          runId: session.lastRunId,
          updatedAt: session.updatedAt,
        },
      },
      session.userId,
    );
  } catch {
    // Best-effort — session row remains source of truth for runStatus.
  }
}

export async function replaceMessages(
  sessionId: string,
  messages: UIMessage[],
  auth: SessionAuthContext = { userId: null },
): Promise<Session> {
  return replaceMessagesSupabase(sessionId, messages, auth);
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
