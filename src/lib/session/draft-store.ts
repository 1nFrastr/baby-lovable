import { isLocalFileStorageMode } from "@/lib/supabase/config";

import {
  createEmptyDraft,
  deleteDraftLocal,
  readDraftLocal,
  writeDraftLocal,
  type SessionDraft,
} from "./draft-store-local";
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
  if (!isLocalFileStorageMode()) {
    return readDraftSupabase(sessionId);
  }
  return readDraftLocal(sessionId, userId);
}

export async function writeDraft(
  sessionId: string,
  draft: SessionDraft,
  userId: string | null = null,
): Promise<void> {
  if (!isLocalFileStorageMode()) {
    return writeDraftSupabase(sessionId, draft, userId);
  }
  return writeDraftLocal(sessionId, draft, userId);
}

export async function deleteDraft(
  sessionId: string,
  userId: string | null = null,
): Promise<void> {
  if (!isLocalFileStorageMode()) {
    return deleteDraftSupabase(sessionId);
  }
  return deleteDraftLocal(sessionId, userId);
}
