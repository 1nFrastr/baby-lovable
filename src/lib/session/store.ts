import type { UIMessage } from "ai";

import {
  type SessionAuthContext,
} from "./auth-context";
import {
  createSessionSupabase,
  getSessionOwnerSupabase,
  getSessionSupabase,
  listSessionsSupabase,
  replaceMessagesSupabase,
  updateSessionSupabase,
  type SessionOwner,
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

const sessionOwnerCache = new Map<string, SessionOwner>();

/** Owner + sandbox mode. Does not load chat messages. Cached per isolate. */
export async function getSessionOwner(
  sessionId: string,
): Promise<SessionOwner | null> {
  const hit = sessionOwnerCache.get(sessionId);
  if (hit) {
    return hit;
  }
  const owner = await getSessionOwnerSupabase(sessionId);
  if (owner) {
    sessionOwnerCache.set(sessionId, owner);
  }
  return owner;
}

export function rememberSessionOwner(
  sessionId: string,
  owner: SessionOwner,
): void {
  sessionOwnerCache.set(sessionId, owner);
}

export function clearSessionOwnerCache(sessionId?: string): void {
  if (sessionId) {
    sessionOwnerCache.delete(sessionId);
    return;
  }
  sessionOwnerCache.clear();
}

export type { SessionOwner };

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
  return updateSessionSupabase(sessionId, input, auth);
}

export async function replaceMessages(
  sessionId: string,
  messages: UIMessage[],
  auth: SessionAuthContext = { userId: null },
): Promise<Session> {
  return replaceMessagesSupabase(sessionId, messages, auth);
}

export function deriveSessionTitle(messages: UIMessage[]): string | undefined {
  const firstUserMessage = messages.find(
    (message) =>
      message.role === "user" &&
      message.parts.some(
        (part) => part.type === "text" && part.text.trim().length > 0,
      ),
  );
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
