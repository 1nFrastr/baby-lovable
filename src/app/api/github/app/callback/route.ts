import { NextResponse } from "next/server";

import {
  exchangeGithubAppOAuthCode,
  findUserInstallationForApp,
  getGithubAuthenticatedUser,
  GithubAppError,
} from "@/lib/github/app-client";
import {
  getGithubAppCallbackUrl,
  getPublicAppOrigin,
} from "@/lib/github/app-config";
import { decodeGithubAppOAuthState } from "@/lib/github/oauth-state";
import { writeGithubAppUserBinding } from "@/lib/github/user-binding-store";
import { getSessionAuthContext } from "@/lib/session/auth-context";
import { isLocalFileStorageMode } from "@/lib/supabase/config";

function redirectWithError(
  origin: string,
  returnTo: string,
  reason: string,
): NextResponse {
  const url = new URL(returnTo, origin);
  url.searchParams.set("github_sync", "error");
  url.searchParams.set("github_sync_error", reason.slice(0, 200));
  return NextResponse.redirect(url);
}

/**
 * GitHub App install + user OAuth callback.
 * Expects `code`, optional `installation_id`, and signed `state`.
 */
export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const origin = getPublicAppOrigin(requestUrl.origin);
  const code = requestUrl.searchParams.get("code");
  const stateRaw = requestUrl.searchParams.get("state");
  const installationIdRaw = requestUrl.searchParams.get("installation_id");
  const errorParam = requestUrl.searchParams.get("error");

  if (errorParam) {
    return redirectWithError(
      origin,
      "/sessions",
      requestUrl.searchParams.get("error_description") ?? errorParam,
    );
  }

  if (!stateRaw) {
    return redirectWithError(origin, "/sessions", "missing_oauth_state");
  }

  let state;
  try {
    state = decodeGithubAppOAuthState(stateRaw);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "invalid_oauth_state";
    return redirectWithError(origin, "/sessions", message);
  }

  const returnTo = state.returnTo || `/sessions/${state.sessionId}`;

  if (!code) {
    // Install-only redirect without user code — enable "Request user authorization"
    // on the GitHub App so install returns an OAuth `code`.
    return redirectWithError(
      origin,
      returnTo,
      "missing_oauth_code_enable_user_authorization_on_github_app",
    );
  }

  const auth = await getSessionAuthContext(request);

  if (!isLocalFileStorageMode() && !auth.userId) {
    const login = new URL("/login", origin);
    login.searchParams.set("next", `${returnTo}?github_sync=1`);
    return NextResponse.redirect(login);
  }

  if (auth.userId && auth.userId !== state.userId) {
    return redirectWithError(
      origin,
      returnTo,
      "oauth_user_mismatch_please_retry",
    );
  }

  const userId = auth.userId ?? state.userId;

  try {
    // Install flow authorize does not send redirect_uri — must omit it on exchange
    // or GitHub returns redirect_uri_mismatch and the binding is never saved.
    // OAuth intent stores the exact redirect_uri in signed state.
    const token = await exchangeGithubAppOAuthCode(code, {
      redirectUri:
        state.intent === "oauth"
          ? (state.redirectUri ?? getGithubAppCallbackUrl(requestUrl.origin))
          : undefined,
    });
    const user = await getGithubAuthenticatedUser(token.accessToken);
    let installationId = installationIdRaw
      ? Number(installationIdRaw)
      : null;
    if (installationId != null && !Number.isFinite(installationId)) {
      installationId = null;
    }

    // Install callback sometimes omits installation_id; resolve from UAT.
    if (installationId == null) {
      try {
        const found = await findUserInstallationForApp(token.accessToken);
        installationId = found?.id ?? null;
      } catch {
        // Best-effort — binding can still be saved; status probe will re-check.
      }
    }

    await writeGithubAppUserBinding({
      userId,
      githubLogin: user.login,
      installationId,
      userAccessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      updatedAt: new Date().toISOString(),
    });

    const success = new URL(returnTo, origin);
    success.searchParams.set("github_sync", "1");
    success.searchParams.delete("github_sync_error");
    return NextResponse.redirect(success);
  } catch (error) {
    const message =
      error instanceof GithubAppError
        ? error.message
        : error instanceof Error
          ? error.message
          : "github_oauth_failed";
    console.error("[github-app/callback]", error);
    return redirectWithError(origin, returnTo, message);
  }
}
