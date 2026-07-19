import type { UIMessage } from "ai";

import type { SandboxMode } from "@/lib/sandbox/types";

/** Current on-disk / future Supabase row schema version. */
export const SESSION_SCHEMA_VERSION = 2;

/**
 * Supabase `auth.users.id` — `null` means anonymous local-dev mode until auth
 * is wired up.
 */
export type UserId = string | null;

/**
 * Mirrors Workflow DevKit run statuses plus an explicit idle state when no run
 * is active. Persisted so the client can decide whether to resume a stream
 * after a page refresh.
 */
export type SessionRunStatus =
  | "idle"
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface Session {
  /** Schema version — bump when the on-disk shape changes. */
  schemaVersion: number;
  id: string;
  /** Owner — `null` for anonymous single-user local mode. */
  userId: UserId;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: UIMessage[];
  /** Active or most-recent workflow run id (for stream reconnection). */
  lastRunId?: string;
  /** Whether a workflow turn is in-flight; drives client resume behaviour. */
  runStatus: SessionRunStatus;
  sandboxMode: SandboxMode;
  /** Soft-delete timestamp — reserved for Supabase row lifecycle. */
  deletedAt?: string | null;
}

export interface SessionSummary {
  id: string;
  userId: UserId;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastRunId?: string;
  runStatus: SessionRunStatus;
  sandboxMode: SandboxMode;
  messageCount: number;
}

export interface CreateSessionInput {
  title?: string;
  sandboxMode?: SandboxMode;
  /** Set from auth context; defaults to `null`. */
  userId?: UserId;
}

export interface UpdateSessionInput {
  title?: string;
  messages?: UIMessage[];
  lastRunId?: string | null;
  runStatus?: SessionRunStatus;
  sandboxMode?: SandboxMode;
  deletedAt?: string | null;
}

/** Returns true when the client should attempt stream reconnection. */
export function isActiveRunStatus(status: SessionRunStatus): boolean {
  return status === "pending" || status === "running";
}

/** Turn finished on the server (messages persisted); post-turn work may still run. */
export function isTerminalRunStatus(status: SessionRunStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled"
  );
}

/**
 * Whether the composer should stay disabled for an in-flight turn.
 *
 * Unlock as soon as session/runtime reports a terminal runStatus — even if
 * useChat is still `streaming`. WorkflowChatTransport keeps the HTTP stream
 * open until the whole workflow returns, which can lag the persisted
 * "completed" signal by a noticeable amount.
 */
export function isLiveChatTurn(
  chatStatus: string,
  runStatus: SessionRunStatus,
): boolean {
  if (isActiveRunStatus(runStatus)) {
    return true;
  }

  const chatBusy =
    chatStatus === "submitted" || chatStatus === "streaming";

  // Idle + just-submitted: lock until the server marks the run active/terminal.
  // Completed/failed while transport still draining: unlock immediately.
  return chatBusy && !isTerminalRunStatus(runStatus);
}
