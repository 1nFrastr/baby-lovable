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
  gitRemote?: string;
  /** Daytona volume subpath for workspace persistence. */
  volumeSubpath?: string;
  /** Active Daytona sandbox id (ephemeral compute). */
  daytonaSandboxId?: string | null;
  /** Last successful git commit in the workspace. */
  lastCommitSha?: string;
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
  gitRemote?: string;
  volumeSubpath?: string;
  daytonaSandboxId?: string | null;
  lastCommitSha?: string;
  deletedAt?: string | null;
}

/** Returns true when the client should attempt stream reconnection. */
export function isActiveRunStatus(status: SessionRunStatus): boolean {
  return status === "pending" || status === "running";
}
