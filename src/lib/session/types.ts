import type { UIMessage } from "ai";

import type { SandboxMode } from "@/lib/sandbox/types";

/** Current Supabase session row schema version. */
export const SESSION_SCHEMA_VERSION = 2;

/** Supabase `auth.users.id`; trusted server workflows may pass `null`. */
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
  /** Schema version — bump when the persisted row shape changes. */
  schemaVersion: number;
  id: string;
  /** Owner; `null` is reserved for trusted server workflow contexts. */
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
  messageCount: number;
}

export interface CreateSessionInput {
  title?: string;
  /** Set from auth context; defaults to `null`. */
  userId?: UserId;
}

export interface UpdateSessionInput {
  title?: string;
  messages?: UIMessage[];
  lastRunId?: string | null;
  runStatus?: SessionRunStatus;
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
 * Whether this turn still blocks sending (auto-finish path).
 *
 * Primary signal is the chat transport:
 * - `ready` / `error` → not in flight (workflow HTTP returned or failed).
 *   Do not keep the composer locked on a stale Realtime `running`.
 * - `submitted` / `streaming` → in flight until server reports terminal
 *   (Realtime/session can unlock early while the HTTP stream still drains).
 *
 * Caveat (turn 2+): after a completed turn, runStatus stays terminal until the
 * next POST. During that gap, chatBusy+terminal looks like post-turn drain —
 * Chat must optimistic-lock on send (`awaitingRunStart` in chat.tsx).
 *
 * User Stop is a separate lock (`stopping` + cancel confirm in composer-lock).
 */
export function isLiveChatTurn(
  chatStatus: string,
  runStatus: SessionRunStatus,
): boolean {
  const chatBusy =
    chatStatus === "submitted" || chatStatus === "streaming";

  // Stream finished = durable workflow returned (persist already ran server-side).
  if (!chatBusy) {
    return false;
  }

  // Still draining HTTP after messages are persisted — unlock for send.
  if (isTerminalRunStatus(runStatus)) {
    return false;
  }

  // Busy and server not terminal yet (active, idle, or unknown).
  return true;
}
