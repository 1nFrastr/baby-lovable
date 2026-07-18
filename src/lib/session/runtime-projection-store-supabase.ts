import { getSupabaseAdminClient } from "@/lib/supabase/admin";

import type { SessionRuntimeProjection } from "./runtime-projection";

interface RuntimeProjectionRow {
  session_id: string;
  user_id: string;
  version: number;
  projection: SessionRuntimeProjection;
  updated_at: string;
}

function isProjection(
  value: unknown,
): value is SessionRuntimeProjection {
  if (!value || typeof value !== "object") {
    return false;
  }
  const obj = value as SessionRuntimeProjection;
  return (
    typeof obj.sessionId === "string" &&
    typeof obj.version === "number" &&
    obj.run != null &&
    obj.preview != null &&
    obj.appTest != null
  );
}

export async function readRuntimeProjectionSupabase(
  sessionId: string,
): Promise<SessionRuntimeProjection | null> {
  const supabase = getSupabaseAdminClient();

  const { data, error } = await supabase
    .from("session_runtime_projection")
    .select("projection")
    .eq("session_id", sessionId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read runtime projection: ${error.message}`);
  }

  if (!data) {
    return null;
  }

  const projection = (data as Pick<RuntimeProjectionRow, "projection">)
    .projection;
  if (!isProjection(projection) || projection.sessionId !== sessionId) {
    return null;
  }
  return projection;
}

export async function writeRuntimeProjectionSupabase(
  projection: SessionRuntimeProjection,
  userId: string | null,
): Promise<void> {
  if (!userId) {
    throw new Error("userId required for Supabase runtime projection storage");
  }

  const supabase = getSupabaseAdminClient();

  const { error } = await supabase.from("session_runtime_projection").upsert(
    {
      session_id: projection.sessionId,
      user_id: userId,
      version: projection.version,
      projection,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "session_id" },
  );

  if (error) {
    throw new Error(`Failed to write runtime projection: ${error.message}`);
  }
}
