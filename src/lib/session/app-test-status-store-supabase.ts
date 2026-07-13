import type { AppTestLatestStatus } from "@/lib/browser-run/types";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

interface AppTestStatusRow {
  session_id: string;
  user_id: string;
  status: AppTestLatestStatus;
  updated_at: string;
}

export async function readAppTestStatusSupabase(
  sessionId: string,
): Promise<AppTestLatestStatus | null> {
  const supabase = getSupabaseAdminClient();

  const { data, error } = await supabase
    .from("session_app_test_status")
    .select("status")
    .eq("session_id", sessionId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read app-test status: ${error.message}`);
  }

  if (!data) {
    return null;
  }

  const status = (data as Pick<AppTestStatusRow, "status">).status;
  if (!status || typeof status !== "object" || !status.status) {
    return null;
  }
  return status;
}

export async function writeAppTestStatusSupabase(
  sessionId: string,
  status: AppTestLatestStatus,
  userId: string | null,
): Promise<void> {
  if (!userId) {
    throw new Error("userId required for Supabase app-test status storage");
  }

  const supabase = getSupabaseAdminClient();

  const { error } = await supabase.from("session_app_test_status").upsert(
    {
      session_id: sessionId,
      user_id: userId,
      status,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "session_id" },
  );

  if (error) {
    throw new Error(`Failed to write app-test status: ${error.message}`);
  }
}
