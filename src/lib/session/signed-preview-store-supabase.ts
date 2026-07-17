import { getSupabaseAdminClient } from "@/lib/supabase/admin";

import type { SignedPreviewCache } from "./signed-preview-store";

interface SignedPreviewRow {
  session_id: string;
  user_id: string;
  cache: SignedPreviewCache;
  updated_at: string;
}

export async function readSignedPreviewSupabase(
  sessionId: string,
): Promise<SignedPreviewCache | null> {
  const supabase = getSupabaseAdminClient();

  const { data, error } = await supabase
    .from("session_signed_preview")
    .select("cache")
    .eq("session_id", sessionId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read signed preview cache: ${error.message}`);
  }

  if (!data) {
    return null;
  }

  const cache = (data as Pick<SignedPreviewRow, "cache">).cache;
  if (
    !cache ||
    typeof cache !== "object" ||
    typeof cache.url !== "string" ||
    typeof cache.sandboxId !== "string" ||
    typeof cache.port !== "number" ||
    typeof cache.expiresAtMs !== "number"
  ) {
    return null;
  }
  return cache;
}

export async function writeSignedPreviewSupabase(
  sessionId: string,
  entry: SignedPreviewCache,
  userId: string | null,
): Promise<void> {
  if (!userId) {
    throw new Error("userId required for Supabase signed preview storage");
  }

  const supabase = getSupabaseAdminClient();

  const { error } = await supabase.from("session_signed_preview").upsert(
    {
      session_id: sessionId,
      user_id: userId,
      cache: entry,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "session_id" },
  );

  if (error) {
    throw new Error(`Failed to write signed preview cache: ${error.message}`);
  }
}

export async function clearSignedPreviewSupabase(
  sessionId: string,
): Promise<void> {
  const supabase = getSupabaseAdminClient();

  const { error } = await supabase
    .from("session_signed_preview")
    .delete()
    .eq("session_id", sessionId);

  if (error) {
    throw new Error(`Failed to clear signed preview cache: ${error.message}`);
  }
}
