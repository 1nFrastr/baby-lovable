import type { UIMessage } from "ai";

import { isLocalFileStorageMode } from "@/lib/supabase/config";
import { getSessionRoot } from "@/lib/sandbox/paths";

import {
  type SessionAuthContext,
} from "./auth-context";
import {
  createSessionLocal,
  getSessionLocal,
  listSessionsLocal,
  replaceMessagesLocal,
  updateSessionLocal,
} from "./store-local";
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
  if (!isLocalFileStorageMode()) {
    return createSessionSupabase(input, auth);
  }
  return createSessionLocal(input, auth);
}

export async function getSession(
  sessionId: string,
  auth: SessionAuthContext = { userId: null },
): Promise<Session | null> {
  if (!isLocalFileStorageMode()) {
    return getSessionSupabase(sessionId, auth);
  }
  return getSessionLocal(sessionId, auth);
}

export async function listSessions(
  auth: SessionAuthContext = { userId: null },
): Promise<SessionSummary[]> {
  if (!isLocalFileStorageMode()) {
    return listSessionsSupabase(auth);
  }
  return listSessionsLocal(auth);
}

export async function updateSession(
  sessionId: string,
  input: UpdateSessionInput,
  auth: SessionAuthContext = { userId: null },
): Promise<Session> {
  if (!isLocalFileStorageMode()) {
    return updateSessionSupabase(sessionId, input, auth);
  }
  return updateSessionLocal(sessionId, input, auth);
}

export async function replaceMessages(
  sessionId: string,
  messages: UIMessage[],
  auth: SessionAuthContext = { userId: null },
): Promise<Session> {
  if (!isLocalFileStorageMode()) {
    return replaceMessagesSupabase(sessionId, messages, auth);
  }
  return replaceMessagesLocal(sessionId, messages, auth);
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

export { getSessionRoot };
