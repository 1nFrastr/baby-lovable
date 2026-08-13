import { isLocalFileStorageMode } from "@/lib/supabase/config";

import type { GithubAppInstallationBinding } from "./installation-binding";
import {
  deleteGithubAppInstallationBindingLocal,
  readGithubAppInstallationBindingLocal,
  writeGithubAppInstallationBindingLocal,
} from "./installation-binding-store-local";
import {
  deleteGithubAppInstallationBindingSupabase,
  readGithubAppInstallationBindingSupabase,
  writeGithubAppInstallationBindingSupabase,
} from "./installation-binding-store-supabase";

export const LOCAL_GITHUB_INSTALLATION_USER_ID = "__local__";

export function githubInstallationUserId(userId: string | null): string {
  if (userId) {
    return userId;
  }
  if (isLocalFileStorageMode()) {
    return LOCAL_GITHUB_INSTALLATION_USER_ID;
  }
  throw new Error("Authenticated user is required for GitHub installation");
}

export async function readGithubAppInstallationBinding(
  userId: string | null,
): Promise<GithubAppInstallationBinding | null> {
  const key = githubInstallationUserId(userId);
  if (isLocalFileStorageMode()) {
    return readGithubAppInstallationBindingLocal(key);
  }
  return readGithubAppInstallationBindingSupabase(key);
}

export async function writeGithubAppInstallationBinding(
  binding: GithubAppInstallationBinding,
): Promise<GithubAppInstallationBinding> {
  if (isLocalFileStorageMode()) {
    return writeGithubAppInstallationBindingLocal(binding);
  }
  return writeGithubAppInstallationBindingSupabase(binding);
}

export async function deleteGithubAppInstallationBinding(
  userId: string | null,
): Promise<void> {
  const key = githubInstallationUserId(userId);
  if (isLocalFileStorageMode()) {
    await deleteGithubAppInstallationBindingLocal(key);
    return;
  }
  await deleteGithubAppInstallationBindingSupabase(key);
}
