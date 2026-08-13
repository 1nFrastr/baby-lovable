import type { AppTestLatestStatus } from "@/lib/browser-run/types";

import {
  readAppTestStatusSupabase,
  writeAppTestStatusSupabase,
} from "./app-test-status-store-supabase";

/**
 * Durable Live View / app-test status in Supabase.
 */
export async function readAppTestStatusStore(
  sessionId: string,
  userId: string | null = null,
): Promise<AppTestLatestStatus | null> {
  void userId;
  return readAppTestStatusSupabase(sessionId);
}

export async function writeAppTestStatusStore(
  sessionId: string,
  status: AppTestLatestStatus,
  userId: string | null = null,
): Promise<void> {
  let ownerId = userId;
  if (!ownerId) {
    const { getSession } = await import("./store");
    const session = await getSession(sessionId);
    ownerId = session?.userId ?? null;
  }
  return writeAppTestStatusSupabase(sessionId, status, ownerId);
}
