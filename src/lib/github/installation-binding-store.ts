import type { GithubAppInstallationBinding } from "./installation-binding";
import {
  deleteGithubAppInstallationBindingSupabase,
  readGithubAppInstallationBindingSupabase,
  writeGithubAppInstallationBindingSupabase,
} from "./installation-binding-store-supabase";

export function githubInstallationUserId(userId: string | null): string {
  if (userId) {
    return userId;
  }
  throw new Error("Authenticated user is required for GitHub installation");
}

export async function readGithubAppInstallationBinding(
  userId: string | null,
): Promise<GithubAppInstallationBinding | null> {
  const key = githubInstallationUserId(userId);
  return readGithubAppInstallationBindingSupabase(key);
}

export async function writeGithubAppInstallationBinding(
  binding: GithubAppInstallationBinding,
): Promise<GithubAppInstallationBinding> {
  return writeGithubAppInstallationBindingSupabase(binding);
}

export async function deleteGithubAppInstallationBinding(
  userId: string | null,
): Promise<void> {
  const key = githubInstallationUserId(userId);
  await deleteGithubAppInstallationBindingSupabase(key);
}
