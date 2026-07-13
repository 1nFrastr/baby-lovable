import type { UIMessage } from "ai";

import { ensureWorkspace } from "@/lib/sandbox/local-provider";
import { getVolumeSubpath } from "@/lib/sandbox/daytona/volume-paths";
import { getDevUserId } from "@/lib/supabase/config";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

import {
  assertSessionOwner,
  type SessionAuthContext,
} from "./auth-context";
import type {
  CreateSessionInput,
  Session,
  SessionRunStatus,
  SessionSummary,
  UpdateSessionInput,
} from "./types";
import { SESSION_SCHEMA_VERSION } from "./types";
import type { SandboxMode } from "@/lib/sandbox/types";

function createSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `sess_${timestamp}${random}`;
}

interface SessionRow {
  id: string;
  user_id: string;
  schema_version: number;
  title: string;
  created_at: string;
  updated_at: string;
  messages: UIMessage[];
  last_run_id: string | null;
  run_status: SessionRunStatus;
  sandbox_mode: SandboxMode;
  git_remote: string | null;
  volume_subpath: string | null;
  daytona_sandbox_id: string | null;
  last_commit_sha: string | null;
  deleted_at: string | null;
}

function rowToSession(row: SessionRow): Session {
  const session: Session = {
    schemaVersion: row.schema_version,
    id: row.id,
    userId: row.user_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages: row.messages ?? [],
    runStatus: row.run_status,
    sandboxMode: row.sandbox_mode,
    deletedAt: row.deleted_at,
  };

  if (row.last_run_id) {
    session.lastRunId = row.last_run_id;
  }
  if (row.git_remote) {
    session.gitRemote = row.git_remote;
  }
  if (row.volume_subpath) {
    session.volumeSubpath = row.volume_subpath;
  }
  if (row.daytona_sandbox_id) {
    session.daytonaSandboxId = row.daytona_sandbox_id;
  }
  if (row.last_commit_sha) {
    session.lastCommitSha = row.last_commit_sha;
  }

  return session;
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

function sessionToRow(session: Session): Omit<SessionRow, "created_at"> & {
  created_at?: string;
} {
  return {
    id: session.id,
    user_id: session.userId!,
    schema_version: session.schemaVersion,
    title: session.title,
    updated_at: session.updatedAt,
    messages: session.messages,
    last_run_id: session.lastRunId ?? null,
    run_status: session.runStatus,
    sandbox_mode: session.sandboxMode,
    git_remote: session.gitRemote ?? null,
    volume_subpath: session.volumeSubpath ?? null,
    daytona_sandbox_id: session.daytonaSandboxId ?? null,
    last_commit_sha: session.lastCommitSha ?? null,
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
    sandboxMode: input.sandboxMode ?? "local",
    deletedAt: null,
  };

  if (session.sandboxMode === "daytona") {
    session.volumeSubpath = getVolumeSubpath(session.id, userId);
  }

  const { error } = await supabase.from("sessions").insert({
    ...sessionToRow(session),
    created_at: now,
  });

  if (error) {
    throw new Error(`Failed to create session: ${error.message}`);
  }

  if (session.sandboxMode === "local") {
    await ensureWorkspace(session.id, userId);
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

  const session = rowToSession(data as SessionRow);
  assertSessionOwner(session.userId, auth);
  return session;
}

export async function listSessionsSupabase(
  auth: SessionAuthContext,
): Promise<SessionSummary[]> {
  const userId = requireUserId(auth);

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to list sessions: ${error.message}`);
  }

  return (data as SessionRow[]).map((row) => toSummary(rowToSession(row)));
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

  const supabase = getSupabaseAdminClient();
  const row = sessionToRow(updated);

  const { error } = await supabase
    .from("sessions")
    .update({
      schema_version: row.schema_version,
      title: row.title,
      updated_at: row.updated_at,
      messages: row.messages,
      last_run_id: row.last_run_id,
      run_status: row.run_status,
      sandbox_mode: row.sandbox_mode,
      git_remote: row.git_remote,
      volume_subpath: row.volume_subpath,
      daytona_sandbox_id: row.daytona_sandbox_id,
      last_commit_sha: row.last_commit_sha,
      deleted_at: row.deleted_at,
    })
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
  return updateSessionSupabase(sessionId, { messages }, auth);
}
