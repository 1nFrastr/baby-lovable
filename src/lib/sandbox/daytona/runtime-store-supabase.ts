import { getSupabaseAdminClient } from "@/lib/supabase/admin";

import {
  emptyRuntimeSnapshot,
  type DaytonaRuntimeSnapshot,
} from "./runtime-state";

interface RuntimeRow {
  session_id: string;
  user_id: string | null;
  revision: number;
  generation: number;
  desired: string;
  observed: string;
  sandbox_id: string | null;
  dev_session_name: string | null;
  preview_url: string | null;
  preview_port: number | null;
  preview_expires_at_ms: number | null;
  last_error: string | null;
  last_observed_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  clear_next_cache: boolean;
  updated_at: string;
}

function rowToSnapshot(row: RuntimeRow): DaytonaRuntimeSnapshot {
  return {
    sessionId: row.session_id,
    revision: row.revision,
    generation: row.generation,
    desired: row.desired as DaytonaRuntimeSnapshot["desired"],
    observed: row.observed as DaytonaRuntimeSnapshot["observed"],
    sandboxId: row.sandbox_id,
    devSessionName: row.dev_session_name,
    previewUrl: row.preview_url,
    previewPort: row.preview_port,
    previewExpiresAtMs: row.preview_expires_at_ms,
    lastError: row.last_error,
    lastObservedAt: row.last_observed_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    clearNextCache: row.clear_next_cache,
  };
}

function snapshotToRow(
  snapshot: DaytonaRuntimeSnapshot,
  userId: string | null,
): Omit<RuntimeRow, "updated_at"> {
  return {
    session_id: snapshot.sessionId,
    user_id: userId,
    revision: snapshot.revision,
    generation: snapshot.generation,
    desired: snapshot.desired,
    observed: snapshot.observed,
    sandbox_id: snapshot.sandboxId,
    dev_session_name: snapshot.devSessionName,
    preview_url: snapshot.previewUrl,
    preview_port: snapshot.previewPort,
    preview_expires_at_ms: snapshot.previewExpiresAtMs,
    last_error: snapshot.lastError,
    last_observed_at: snapshot.lastObservedAt,
    lease_owner: snapshot.leaseOwner,
    lease_expires_at: snapshot.leaseExpiresAt,
    clear_next_cache: snapshot.clearNextCache ?? false,
  };
}

export async function readRuntimeSupabase(
  sessionId: string,
): Promise<DaytonaRuntimeSnapshot | null> {
  const supabase = getSupabaseAdminClient();

  const { data, error } = await supabase
    .from("session_daytona_runtime")
    .select("*")
    .eq("session_id", sessionId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read daytona runtime: ${error.message}`);
  }

  if (!data) {
    return null;
  }

  return rowToSnapshot(data as RuntimeRow);
}

export async function writeRuntimeSupabase(
  snapshot: DaytonaRuntimeSnapshot,
  userId: string | null,
  expectedRevision: number | null,
): Promise<DaytonaRuntimeSnapshot> {
  const supabase = getSupabaseAdminClient();
  const row = {
    ...snapshotToRow(snapshot, userId),
    updated_at: new Date().toISOString(),
  };

  if (expectedRevision === null || expectedRevision === 0) {
    const { data, error } = await supabase
      .from("session_daytona_runtime")
      .upsert(row, { onConflict: "session_id" })
      .select("*")
      .single();

    if (error) {
      throw new Error(`Failed to write daytona runtime: ${error.message}`);
    }
    return rowToSnapshot(data as RuntimeRow);
  }

  const { data, error } = await supabase
    .from("session_daytona_runtime")
    .update(row)
    .eq("session_id", snapshot.sessionId)
    .eq("revision", expectedRevision)
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to CAS-update daytona runtime: ${error.message}`);
  }

  if (!data) {
    throw new Error(
      `Daytona runtime CAS conflict for ${snapshot.sessionId} (expected revision ${expectedRevision})`,
    );
  }

  return rowToSnapshot(data as RuntimeRow);
}

export async function deleteRuntimeSupabase(sessionId: string): Promise<void> {
  const supabase = getSupabaseAdminClient();

  const { error } = await supabase
    .from("session_daytona_runtime")
    .delete()
    .eq("session_id", sessionId);

  if (error) {
    throw new Error(`Failed to delete daytona runtime: ${error.message}`);
  }
}

export function defaultSupabaseSnapshot(
  sessionId: string,
): DaytonaRuntimeSnapshot {
  return emptyRuntimeSnapshot(sessionId);
}
