/**
 * Durable Daytona signed preview URL cache.
 * Local file mode: session `signed-preview.json`.
 * Supabase: `session_signed_preview` (cross-isolate on Vercel / Workflow steps).
 */

import { isLocalFileStorageMode } from "@/lib/supabase/config";

import {
  clearSignedPreviewLocal,
  readSignedPreviewLocal,
  writeSignedPreviewLocal,
} from "./signed-preview-store-local";
import {
  clearSignedPreviewSupabase,
  readSignedPreviewSupabase,
  writeSignedPreviewSupabase,
} from "./signed-preview-store-supabase";

export type SignedPreviewCache = {
  url: string;
  sandboxId: string;
  port: number;
  expiresAtMs: number;
};

/** Process-local L1 — avoids a store round-trip on hot paths. */
const memory = new Map<string, SignedPreviewCache>();

export async function readSignedPreviewStore(
  sessionId: string,
  userId: string | null = null,
): Promise<SignedPreviewCache | null> {
  const hit = memory.get(sessionId);
  if (hit) {
    return hit;
  }

  try {
    const loaded = !isLocalFileStorageMode()
      ? await readSignedPreviewSupabase(sessionId)
      : await readSignedPreviewLocal(sessionId, userId);

    if (loaded) {
      memory.set(sessionId, loaded);
    }
    return loaded;
  } catch {
    return null;
  }
}

export async function writeSignedPreviewStore(
  sessionId: string,
  entry: SignedPreviewCache,
  userId: string | null = null,
): Promise<void> {
  memory.set(sessionId, entry);

  try {
    if (!isLocalFileStorageMode()) {
      let ownerId = userId;
      if (!ownerId) {
        const { getSession } = await import("./store");
        const session = await getSession(sessionId);
        ownerId = session?.userId ?? null;
      }
      await writeSignedPreviewSupabase(sessionId, entry, ownerId);
      return;
    }

    await writeSignedPreviewLocal(sessionId, entry, userId);
  } catch {
    // Durable write is best-effort; L1 memory still helps this isolate.
  }
}

export async function clearSignedPreviewStore(
  sessionId: string,
): Promise<void> {
  memory.delete(sessionId);

  try {
    if (!isLocalFileStorageMode()) {
      await clearSignedPreviewSupabase(sessionId);
      return;
    }

    await clearSignedPreviewLocal(sessionId);
  } catch {
    // ignore — stop/delete must not fail on cache cleanup
  }
}
