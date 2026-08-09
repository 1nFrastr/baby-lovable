import { isLocalFileStorageMode } from "@/lib/supabase/config";

import {
  refreshGithubAppUserToken,
  getGithubAuthenticatedUser,
  assertGithubAppInstalledForUser,
  isGithubAppInstallMissingError,
  GithubAppError,
} from "./app-client";
import {
  isGithubAccessTokenExpired,
  type GithubAppUserBinding,
} from "./user-binding";
import {
  deleteGithubAppUserBindingLocal,
  readGithubAppUserBindingLocal,
  writeGithubAppUserBindingLocal,
} from "./user-binding-store-local";
import {
  deleteGithubAppUserBindingSupabase,
  readGithubAppUserBindingSupabase,
  writeGithubAppUserBindingSupabase,
} from "./user-binding-store-supabase";

export async function readGithubAppUserBinding(
  userId: string,
): Promise<GithubAppUserBinding | null> {
  if (isLocalFileStorageMode()) {
    return readGithubAppUserBindingLocal(userId);
  }
  return readGithubAppUserBindingSupabase(userId);
}

export async function writeGithubAppUserBinding(
  binding: GithubAppUserBinding,
): Promise<GithubAppUserBinding> {
  if (isLocalFileStorageMode()) {
    return writeGithubAppUserBindingLocal(binding);
  }
  return writeGithubAppUserBindingSupabase(binding);
}

export async function deleteGithubAppUserBinding(
  userId: string,
): Promise<void> {
  if (isLocalFileStorageMode()) {
    await deleteGithubAppUserBindingLocal(userId);
    return;
  }
  await deleteGithubAppUserBindingSupabase(userId);
}

/**
 * Return a usable user access token, refreshing when expired.
 * Throws GithubAppError(401) when re-authorization is required.
 * Clears the stored binding when refresh fails (stale after uninstall / revoke).
 */
export async function resolveGithubUserAccessToken(
  userId: string,
): Promise<{ token: string; binding: GithubAppUserBinding }> {
  const binding = await readGithubAppUserBinding(userId);
  if (!binding) {
    throw new GithubAppError("GitHub App is not authorized for this user", 401);
  }

  if (!isGithubAccessTokenExpired(binding)) {
    return { token: binding.userAccessToken, binding };
  }

  if (!binding.refreshToken) {
    await deleteGithubAppUserBinding(userId).catch(() => undefined);
    throw new GithubAppError(
      "GitHub 授权已失效，请重新授权安装",
      401,
    );
  }

  try {
    const refreshed = await refreshGithubAppUserToken(binding.refreshToken);
    const user = await getGithubAuthenticatedUser(refreshed.accessToken);
    const next = await writeGithubAppUserBinding({
      ...binding,
      githubLogin: user.login,
      userAccessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? binding.refreshToken,
      expiresAt: refreshed.expiresAt,
    });
    return { token: next.userAccessToken, binding: next };
  } catch (error) {
    await deleteGithubAppUserBinding(userId).catch(() => undefined);
    if (error instanceof GithubAppError && error.status === 401) {
      throw new GithubAppError(
        "GitHub 授权已失效，请重新授权安装",
        401,
      );
    }
    throw new GithubAppError(
      error instanceof Error
        ? `GitHub token refresh failed: ${error.message}`
        : "GitHub 授权已失效，请重新授权安装",
      401,
    );
  }
}

/**
 * Resolve token and confirm the platform App is still installed.
 * On uninstall / revoke: clears binding and throws 401.
 */
export async function verifyGithubAppUserBinding(
  userId: string,
): Promise<{ token: string; binding: GithubAppUserBinding }> {
  const resolved = await resolveGithubUserAccessToken(userId);
  try {
    const installationId = await assertGithubAppInstalledForUser(
      resolved.token,
      resolved.binding.installationId,
    );
    if (installationId !== resolved.binding.installationId) {
      const next = await writeGithubAppUserBinding({
        ...resolved.binding,
        installationId,
        updatedAt: new Date().toISOString(),
      });
      return { token: resolved.token, binding: next };
    }
    return resolved;
  } catch (error) {
    if (
      isGithubAppInstallMissingError(error) ||
      (error instanceof GithubAppError && error.status === 401)
    ) {
      await deleteGithubAppUserBinding(userId).catch(() => undefined);
      throw new GithubAppError(
        error instanceof Error
          ? error.message
          : "GitHub App 已卸载或未安装，请重新授权安装",
        401,
      );
    }
    throw error;
  }
}
