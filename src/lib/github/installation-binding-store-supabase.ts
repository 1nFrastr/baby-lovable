import { getSupabaseAdminClient } from "@/lib/supabase/admin";

import type { GithubAppInstallationBinding } from "./installation-binding";

interface Row {
  user_id: string;
  installation_id: number;
  github_account_id: number;
  github_login: string;
  updated_at: string;
}

function fromRow(row: Row): GithubAppInstallationBinding {
  return {
    userId: row.user_id,
    installationId: Number(row.installation_id),
    githubAccountId: Number(row.github_account_id),
    githubLogin: row.github_login,
    updatedAt: row.updated_at,
  };
}

export async function readGithubAppInstallationBindingSupabase(
  userId: string,
): Promise<GithubAppInstallationBinding | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("user_github_app_installations")
    .select(
      "user_id, installation_id, github_account_id, github_login, updated_at",
    )
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to read GitHub App installation: ${error.message}`);
  }
  return data ? fromRow(data as Row) : null;
}

export async function writeGithubAppInstallationBindingSupabase(
  binding: GithubAppInstallationBinding,
): Promise<GithubAppInstallationBinding> {
  const supabase = getSupabaseAdminClient();
  const updatedAt = new Date().toISOString();
  const { error } = await supabase.from("user_github_app_installations").upsert(
    {
      user_id: binding.userId,
      installation_id: binding.installationId,
      github_account_id: binding.githubAccountId,
      github_login: binding.githubLogin,
      updated_at: updatedAt,
    },
    { onConflict: "user_id" },
  );
  if (error) {
    throw new Error(`Failed to write GitHub App installation: ${error.message}`);
  }
  return { ...binding, updatedAt };
}

export async function deleteGithubAppInstallationBindingSupabase(
  userId: string,
): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase
    .from("user_github_app_installations")
    .delete()
    .eq("user_id", userId);
  if (error) {
    throw new Error(`Failed to delete GitHub App installation: ${error.message}`);
  }
}
