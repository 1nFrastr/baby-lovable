import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  getSupabaseSecretKey,
  getSupabaseUrl,
  isSupabaseAdminConfigured,
} from "./config";

let adminClient: SupabaseClient | null = null;

/**
 * Service-role client for trusted server contexts (workflow steps, CLI).
 * Bypasses RLS — callers must enforce authorization themselves.
 */
export function getSupabaseAdminClient(): SupabaseClient {
  if (!isSupabaseAdminConfigured()) {
    throw new Error(
      "Supabase admin client is not configured. Set SUPABASE_SECRET_KEY (synced via Vercel Marketplace).",
    );
  }

  if (!adminClient) {
    adminClient = createClient(getSupabaseUrl()!, getSupabaseSecretKey()!, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }

  return adminClient;
}
