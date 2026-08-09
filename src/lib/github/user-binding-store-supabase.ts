import { getSupabaseAdminClient } from "@/lib/supabase/admin";

import {
  normalizeGithubAppUserBinding,
  type GithubAppUserBinding,
} from "./user-binding";

interface Row {
  user_id: string;
  binding: unknown;
}

export async function readGithubAppUserBindingSupabase(
  userId: string,
): Promise<GithubAppUserBinding | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("user_github_app_bindings")
    .select("user_id, binding")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read GitHub App binding: ${error.message}`);
  }
  if (!data) {
    return null;
  }
  const row = data as Row;
  const normalized = normalizeGithubAppUserBinding(row.binding);
  if (normalized && normalized.userId !== userId) {
    return { ...normalized, userId };
  }
  return normalized;
}

export async function writeGithubAppUserBindingSupabase(
  binding: GithubAppUserBinding,
): Promise<GithubAppUserBinding> {
  const supabase = getSupabaseAdminClient();
  const payload: GithubAppUserBinding = {
    ...binding,
    updatedAt: new Date().toISOString(),
  };
  const { error } = await supabase.from("user_github_app_bindings").upsert(
    {
      user_id: binding.userId,
      binding: payload,
      updated_at: payload.updatedAt,
    },
    { onConflict: "user_id" },
  );
  if (error) {
    throw new Error(`Failed to write GitHub App binding: ${error.message}`);
  }
  return payload;
}

export async function deleteGithubAppUserBindingSupabase(
  userId: string,
): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase
    .from("user_github_app_bindings")
    .delete()
    .eq("user_id", userId);
  if (error) {
    throw new Error(`Failed to delete GitHub App binding: ${error.message}`);
  }
}
