import { NextResponse } from "next/server";

import {
  getGithubAppInstallation,
  GithubAppError,
} from "@/lib/github/app-client";
import { getPublicAppOrigin } from "@/lib/github/app-config";
import { decodeGithubAppInstallState } from "@/lib/github/install-state";
import {
  githubInstallationUserId,
  writeGithubAppInstallationBinding,
} from "@/lib/github/installation-binding-store";
import { getSessionAuthContext } from "@/lib/session/auth-context";

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

/** GitHub App Setup URL. This flow never exchanges a user OAuth code. */
export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const origin = getPublicAppOrigin(requestUrl.origin);
  const stateRaw = requestUrl.searchParams.get("state");
  const installationIdRaw = requestUrl.searchParams.get("installation_id");
  const setupAction = requestUrl.searchParams.get("setup_action");
  const errorParam = requestUrl.searchParams.get("error");

  if (errorParam) {
    return redirectWithError(
      origin,
      "/sessions",
      requestUrl.searchParams.get("error_description") ?? errorParam,
    );
  }
  if (!stateRaw) {
    return redirectWithError(origin, "/sessions", "missing_installation_state");
  }

  let state;
  try {
    state = decodeGithubAppInstallState(stateRaw);
  } catch (error) {
    return redirectWithError(
      origin,
      "/sessions",
      error instanceof Error ? error.message : "invalid_installation_state",
    );
  }

  const returnTo = state.returnTo || `/sessions/${state.sessionId}`;
  if (!installationIdRaw || setupAction === "request") {
    return redirectWithError(
      origin,
      returnTo,
      setupAction === "request"
        ? "GitHub App installation is still pending approval"
        : "missing_installation_id",
    );
  }
  const installationId = Number(installationIdRaw);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return redirectWithError(origin, returnTo, "invalid_installation_id");
  }

  const auth = await getSessionAuthContext(request);
  if (!auth.userId) {
    return redirectWithError(
      origin,
      returnTo,
      "Please sign in with GitHub first",
    );
  }
  if (state.userId !== auth.userId) {
    return redirectWithError(
      origin,
      returnTo,
      "installation_user_mismatch_please_retry",
    );
  }
  if (!auth.githubIdentity) {
    return redirectWithError(
      origin,
      returnTo,
      "Current account is not a GitHub login; cannot verify installation ownership",
    );
  }

  try {
    const installation = await getGithubAppInstallation(installationId);
    if (installation.suspended) {
      throw new GithubAppError("GitHub App installation is suspended", 403);
    }
    if (installation.accountType !== "User") {
      throw new GithubAppError(
        "Only personal GitHub account repositories are supported",
        400,
      );
    }
    if (
      auth.githubIdentity &&
      installation.accountId !== auth.githubIdentity.id
    ) {
      throw new GithubAppError(
        "GitHub App installation does not belong to the current account",
        403,
      );
    }

    await writeGithubAppInstallationBinding({
      userId: githubInstallationUserId(auth.userId),
      installationId: installation.id,
      githubAccountId: installation.accountId,
      githubLogin: installation.accountLogin,
      updatedAt: new Date().toISOString(),
    });

    const success = new URL(returnTo, origin);
    success.searchParams.set("github_sync", "installed");
    success.searchParams.delete("github_sync_error");
    return NextResponse.redirect(success);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "github_installation_failed";
    console.error("[github-app/setup]", error);
    return redirectWithError(origin, returnTo, message);
  }
}
