import type { UIMessage } from "ai";

import { getSupabaseAdminClient } from "@/lib/supabase/admin";

import type { SessionDraft } from "./draft-store-local";

interface DraftRow {
  session_id: string;
  user_id: string;
  run_id: string;
  message: UIMessage;
  updated_at: string;
}

function rowToDraft(row: DraftRow): SessionDraft {
  return {
    runId: row.run_id,
    message: row.message,
    updatedAt: row.updated_at,
  };
}

export async function readDraftSupabase(
  sessionId: string,
): Promise<SessionDraft | null> {
  const supabase = getSupabaseAdminClient();

  const { data, error } = await supabase
    .from("session_drafts")
    .select("*")
    .eq("session_id", sessionId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read draft: ${error.message}`);
  }

  if (!data) {
    return null;
  }

  return rowToDraft(data as DraftRow);
}

export async function writeDraftSupabase(
  sessionId: string,
  draft: SessionDraft,
  userId: string | null,
): Promise<void> {
  if (!userId) {
    throw new Error("userId required for Supabase draft storage");
  }

  const supabase = getSupabaseAdminClient();

  const { error } = await supabase.from("session_drafts").upsert(
    {
      session_id: sessionId,
      user_id: userId,
      run_id: draft.runId,
      message: draft.message,
      updated_at: draft.updatedAt,
    },
    { onConflict: "session_id" },
  );

  if (error) {
    throw new Error(`Failed to write draft: ${error.message}`);
  }
}

export async function deleteDraftSupabase(sessionId: string): Promise<void> {
  const supabase = getSupabaseAdminClient();

  const { error } = await supabase
    .from("session_drafts")
    .delete()
    .eq("session_id", sessionId);

  if (error) {
    throw new Error(`Failed to delete draft: ${error.message}`);
  }
}
