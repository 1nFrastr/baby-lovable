import type { UIMessage } from "ai";

import { getDevUserId } from "@/lib/supabase/config";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

import {
  assertSessionOwner,
  type SessionAuthContext,
} from "./auth-context";
import {
  hydrateSessionRow,
  loadSessionMessages,
  rpcReplaceSessionMessages,
} from "./session-messages";
import type { SessionRow } from "./session-row";
import type {
  CreateSessionInput,
  Session,
  SessionSummary,
  UpdateSessionInput,
} from "./types";
import { SESSION_SCHEMA_VERSION } from "./types";
import {
  assertSandboxMode,
  getDefaultSandboxMode,
  type SandboxMode,
} from "@/lib/sandbox/types";

export interface SessionOwner {
  userId: string | null;
  sandboxMode: SandboxMode;
}

function createSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `sess_${timestamp}${random}`;
}

export function rowToSession(
  row: SessionRow & { messages?: UIMessage[] },
  messages: UIMessage[] = row.messages ?? [],
): Session {
  assertSandboxMode(row.sandbox_mode, row.id);
  const session: Session = {
    schemaVersion: row.schema_version,
    id: row.id,
    userId: row.user_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages,
    runStatus: row.run_status,
    conversationRevision: row.conversation_revision ?? 0,
    turnCheckpoint: row.turn_checkpoint ?? -1,
    sandboxMode: row.sandbox_mode,
    deletedAt: row.deleted_at,
  };

  if (row.last_run_id) {
    session.lastRunId = row.last_run_id;
  }
  if (row.active_turn_id) {
    session.activeTurnId = row.active_turn_id;
  }
  if (row.active_assistant_message_id) {
    session.activeAssistantMessageId = row.active_assistant_message_id;
  }
  if (row.active_turn_started_at) {
    session.activeTurnStartedAt = row.active_turn_started_at;
  }

  return session;
}

function toSummary(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunId: row.last_run_id ?? undefined,
    runStatus: row.run_status,
    messageCount: row.message_count ?? 0,
  };
}

function sessionToRow(session: Session): Omit<SessionRow, "created_at"> & {
  created_at?: string;
} {
  return {
    id: session.id,
    user_id: session.userId!,
    schema_version: session.schemaVersion,
    title: session.title,
    updated_at: session.updatedAt,
    message_count: session.messages.length,
    last_run_id: session.lastRunId ?? null,
    run_status: session.runStatus,
    active_turn_id: session.activeTurnId ?? null,
    active_assistant_message_id: session.activeAssistantMessageId ?? null,
    conversation_revision: session.conversationRevision,
    turn_checkpoint: session.turnCheckpoint,
    active_turn_started_at: session.activeTurnStartedAt ?? null,
    sandbox_mode: session.sandboxMode,
    deleted_at: session.deletedAt ?? null,
  };
}

function requireUserId(
  auth: SessionAuthContext,
  inputUserId?: string | null,
): string {
  const userId = inputUserId ?? auth.userId ?? getDevUserId() ?? null;
  if (!userId) {
    throw new Error("Authenticated user required for Supabase session storage");
  }
  return userId;
}

export async function createSessionSupabase(
  input: CreateSessionInput = {},
  auth: SessionAuthContext,
): Promise<Session> {
  const userId = requireUserId(auth, input.userId);
  const now = new Date().toISOString();
  const supabase = getSupabaseAdminClient();

  const session: Session = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: createSessionId(),
    userId,
    title: input.title ?? "New Project",
    createdAt: now,
    updatedAt: now,
    messages: [],
    runStatus: "idle",
    conversationRevision: 0,
    turnCheckpoint: -1,
    sandboxMode: getDefaultSandboxMode(),
    deletedAt: null,
  };

  const { error } = await supabase.from("sessions").insert({
    ...sessionToRow(session),
    created_at: now,
  });

  if (error) {
    throw new Error(`Failed to create session: ${error.message}`);
  }

  return session;
}

export async function getSessionSupabase(
  sessionId: string,
  auth: SessionAuthContext = { userId: null },
): Promise<Session | null> {
  const supabase = getSupabaseAdminClient();

  const { data, error } = await supabase
    .from("sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read session: ${error.message}`);
  }

  if (!data || data.deleted_at) {
    return null;
  }

  const hydrated = await hydrateSessionRow(data as SessionRow);
  const session = rowToSession(hydrated);
  assertSessionOwner(session.userId, auth);
  return session;
}

/** Owner + sandbox mode only — no message hydrate. */
export async function getSessionOwnerSupabase(
  sessionId: string,
): Promise<SessionOwner | null> {
  const supabase = getSupabaseAdminClient();

  const { data, error } = await supabase
    .from("sessions")
    .select("user_id, sandbox_mode, deleted_at")
    .eq("id", sessionId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read session owner: ${error.message}`);
  }

  if (!data || data.deleted_at) {
    return null;
  }

  const row = data as Pick<SessionRow, "user_id" | "sandbox_mode" | "deleted_at">;
  assertSandboxMode(row.sandbox_mode, sessionId);
  return {
    userId: row.user_id,
    sandboxMode: row.sandbox_mode,
  };
}

export async function listSessionsSupabase(
  auth: SessionAuthContext,
): Promise<SessionSummary[]> {
  const userId = requireUserId(auth);

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("sessions")
    .select(
      "id, user_id, title, created_at, updated_at, last_run_id, run_status, message_count",
    )
    .eq("user_id", userId)
    .eq("sandbox_mode", "daytona")
    .is("deleted_at", null)
    .order("updated_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to list sessions: ${error.message}`);
  }

  return (data as SessionRow[]).map((row) => toSummary(row));
}

export async function updateSessionSupabase(
  sessionId: string,
  input: UpdateSessionInput,
  auth: SessionAuthContext = { userId: null },
): Promise<Session> {
  const existing = await getSessionSupabase(sessionId, auth);
  if (!existing) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const { lastRunId, messages, ...rest } = input;

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

  if (messages !== undefined) {
    updated.messages = messages;
  }

  const patch: Record<string, unknown> = {
    updated_at: updated.updatedAt,
    schema_version: SESSION_SCHEMA_VERSION,
  };
  if (input.title !== undefined) {
    patch.title = updated.title;
  }
  if (input.runStatus !== undefined) {
    patch.run_status = updated.runStatus;
  }
  if (input.deletedAt !== undefined) {
    patch.deleted_at = updated.deletedAt ?? null;
  }
  if (lastRunId !== undefined) {
    patch.last_run_id = updated.lastRunId ?? null;
  }

  const supabase = getSupabaseAdminClient();

  if (messages !== undefined) {
    const row = await rpcReplaceSessionMessages({
      sessionId,
      expectedRevision: existing.conversationRevision,
      messages,
    });
    if (!row) {
      throw new Error(
        `Failed to replace session messages during update: ${sessionId}`,
      );
    }
    if (Object.keys(patch).length > 2) {
      const { error } = await supabase
        .from("sessions")
        .update(patch)
        .eq("id", sessionId);
      if (error) {
        throw new Error(`Failed to update session: ${error.message}`);
      }
    }
    return getSessionSupabase(sessionId, auth) as Promise<Session>;
  }

  const { error } = await supabase
    .from("sessions")
    .update(patch)
    .eq("id", sessionId);

  if (error) {
    throw new Error(`Failed to update session: ${error.message}`);
  }

  return updated;
}

export async function replaceMessagesSupabase(
  sessionId: string,
  messages: UIMessage[],
  auth: SessionAuthContext = { userId: null },
): Promise<Session> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const existing = await getSessionSupabase(sessionId, auth);
    if (!existing) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const row = await rpcReplaceSessionMessages({
      sessionId,
      expectedRevision: existing.conversationRevision,
      messages,
    });

    if (row) {
      return rowToSession(
        await hydrateSessionRow(row as SessionRow),
      );
    }
  }

  throw new Error(
    `Failed to replace messages after optimistic concurrency retries: ${sessionId}`,
  );
}

export async function loadSessionMessagesForRow(
  sessionId: string,
): Promise<UIMessage[]> {
  return loadSessionMessages(sessionId);
}

export type { SessionRow } from "./session-row";
