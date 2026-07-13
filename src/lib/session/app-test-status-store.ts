import type { AppTestLatestStatus } from "@/lib/browser-run/types";
import { isLocalFileStorageMode } from "@/lib/supabase/config";

import {
  readAppTestStatusLocal,
  writeAppTestStatusLocal,
} from "./app-test-status-store-local";
import {
  readAppTestStatusSupabase,
  writeAppTestStatusSupabase,
} from "./app-test-status-store-supabase";

/**
 * Durable Live View / app-test status for Web UI pollers.
 * Local file mode: session `app-test-status.json`.
 * Supabase: `session_app_test_status` (cross-isolate on Vercel).
 */
export async function readAppTestStatusStore(
  sessionId: string,
  userId: string | null = null,
): Promise<AppTestLatestStatus | null> {
  if (!isLocalFileStorageMode()) {
    return readAppTestStatusSupabase(sessionId);
  }
  return readAppTestStatusLocal(sessionId, userId);
}

export async function writeAppTestStatusStore(
  sessionId: string,
  status: AppTestLatestStatus,
  userId: string | null = null,
): Promise<void> {
  if (!isLocalFileStorageMode()) {
    let ownerId = userId;
    if (!ownerId) {
      const { getSession } = await import("./store");
      const session = await getSession(sessionId);
      ownerId = session?.userId ?? null;
    }
    return writeAppTestStatusSupabase(sessionId, status, ownerId);
  }
  return writeAppTestStatusLocal(sessionId, status, userId);
}
