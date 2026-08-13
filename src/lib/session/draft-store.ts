import {
  createEmptyDraft,
  type SessionDraft,
} from "./draft-types";
import {
  deleteDraftSupabase,
  readDraftSupabase,
  writeDraftSupabase,
} from "./draft-store-supabase";

export type { SessionDraft };
export { createEmptyDraft };

export async function readDraft(
  sessionId: string,
  userId: string | null = null,
): Promise<SessionDraft | null> {
  void userId;
  return readDraftSupabase(sessionId);
}

export async function writeDraft(
  sessionId: string,
  draft: SessionDraft,
  userId: string | null = null,
): Promise<void> {
  return writeDraftSupabase(sessionId, draft, userId);
}

export async function deleteDraft(
  sessionId: string,
  userId: string | null = null,
): Promise<void> {
  void userId;
  return deleteDraftSupabase(sessionId);
}
