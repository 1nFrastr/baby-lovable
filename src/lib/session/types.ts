import type { UIMessage } from "ai";

import type { SandboxMode } from "@/lib/sandbox/types";

/** Current Supabase session row schema version. */
export const SESSION_SCHEMA_VERSION = 3;

/** Supabase `auth.users.id`; trusted server workflows may pass `null`. */
export type UserId = string | null;

/**
 * Server-owned chat-turn lifecycle. Composer lock and Stop follow this field
 * together with `activeTurnId`; clients must not infer sendability from a
 * local stream alone.
 */
export type SessionRunStatus =
  | "idle"
  | "pending"
  | "running"
  | "cancelling"
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
  /** Active workflow run id (for cancellation and same-connection recovery). */
  lastRunId?: string;
  /** Server-owned lifecycle state. */
  runStatus: SessionRunStatus;
  /** Fencing token for the only turn allowed to write this session/workspace. */
  activeTurnId?: string;
  /** Stable UIMessage id for the active assistant bubble. */
  activeAssistantMessageId?: string;
  /** Monotonic revision for messages and turn lifecycle changes. */
  conversationRevision: number;
  /** Highest fully materialized agent step for the active turn. */
  turnCheckpoint: number;
  /** Used to repair a pending turn whose request died before workflow start. */
  activeTurnStartedAt?: string;
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
  return (
    status === "pending" ||
    status === "running" ||
    status === "cancelling"
  );
}

/** Turn finished on the server (messages persisted); post-turn work may still run. */
export function isTerminalRunStatus(status: SessionRunStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled"
  );
}

