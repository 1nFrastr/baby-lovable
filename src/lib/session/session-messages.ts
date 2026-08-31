import type { UIMessage } from "ai";

import { sanitizeJsonbText, sanitizeJsonbValue } from "@/lib/json/sanitize-jsonb";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

import type { SessionRow } from "./session-row";

export interface SessionMessageRow {
  session_id: string;
  message_id: string;
  position: number;
  role: string;
  message: UIMessage;
  created_at: string;
  updated_at: string;
}

export async function loadSessionMessages(
  sessionId: string,
): Promise<UIMessage[]> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("session_messages")
    .select("message")
    .eq("session_id", sessionId)
    .order("position", { ascending: true });

  if (error) {
    throw new Error(`Failed to load session messages: ${error.message}`);
  }

  return (data ?? []).map((row) => row.message as UIMessage);
}

export async function sessionMessageExists(
  sessionId: string,
  messageId: string,
): Promise<boolean> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("session_messages")
    .select("message_id")
    .eq("session_id", sessionId)
    .eq("message_id", messageId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to check session message: ${error.message}`);
  }

  return data != null;
}

export async function rpcClaimSessionTurn(input: {
  sessionId: string;
  expectedRevision: number;
  turnId: string;
  assistantMessageId: string;
  userMessage: UIMessage;
  assistantMessage: UIMessage;
  title: string;
  startedAt: string;
}): Promise<SessionRow | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase.rpc("cas_claim_session_turn", {
    p_session_id: input.sessionId,
    p_expected_revision: input.expectedRevision,
    p_turn_id: input.turnId,
    p_assistant_message_id: input.assistantMessageId,
    p_user_message: sanitizeJsonbValue(input.userMessage),
    p_assistant_message: sanitizeJsonbValue(input.assistantMessage),
    p_title: sanitizeJsonbText(input.title),
    p_started_at: input.startedAt,
  });

  if (error) {
    throw new Error(`Failed to claim session turn: ${error.message}`);
  }

  const row = (data as SessionRow[] | null)?.[0] ?? null;
  return row;
}

export async function rpcUpdateAssistantMessage(input: {
  sessionId: string;
  expectedRevision: number;
  turnId: string;
  assistantMessageId: string;
  message: UIMessage;
  turnCheckpoint?: number;
}): Promise<SessionRow | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase.rpc("cas_update_assistant_message", {
    p_session_id: input.sessionId,
    p_expected_revision: input.expectedRevision,
    p_expected_turn_id: input.turnId,
    p_assistant_message_id: input.assistantMessageId,
    p_message: sanitizeJsonbValue(input.message),
    p_turn_checkpoint: input.turnCheckpoint ?? null,
  });

  if (error) {
    throw new Error(`Failed to update assistant message: ${error.message}`);
  }

  return (data as SessionRow[] | null)?.[0] ?? null;
}

export async function rpcTerminalSessionTurn(input: {
  sessionId: string;
  expectedRevision: number;
  turnId: string;
  assistantMessageId: string;
  message: UIMessage | null;
  checkpoint: number;
  status: "completed" | "failed" | "cancelled";
}): Promise<SessionRow | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase.rpc("cas_terminal_session_turn", {
    p_session_id: input.sessionId,
    p_expected_revision: input.expectedRevision,
    p_expected_turn_id: input.turnId,
    p_assistant_message_id: input.assistantMessageId,
    p_message: input.message ? sanitizeJsonbValue(input.message) : null,
    p_checkpoint: input.checkpoint,
    p_status: input.status,
  });

  if (error) {
    throw new Error(`Failed to terminal session turn: ${error.message}`);
  }

  return (data as SessionRow[] | null)?.[0] ?? null;
}

export async function rpcReplaceSessionMessages(input: {
  sessionId: string;
  expectedRevision: number;
  messages: UIMessage[];
}): Promise<SessionRow | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase.rpc("cas_replace_session_messages", {
    p_session_id: input.sessionId,
    p_expected_revision: input.expectedRevision,
    p_messages: sanitizeJsonbValue(input.messages),
  });

  if (error) {
    throw new Error(`Failed to replace session messages: ${error.message}`);
  }

  return (data as SessionRow[] | null)?.[0] ?? null;
}

export async function hydrateSessionRow(
  row: SessionRow,
): Promise<SessionRow & { messages: UIMessage[] }> {
  const messages = await loadSessionMessages(row.id);
  return { ...row, messages };
}
