import type { User } from "@supabase/supabase-js";

import type { UserId } from "./types";
import { getDevUserId } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface SessionAuthContext {
  /** `null` is reserved for trusted workflow/CLI calls without a cookie. */
  userId: UserId;
  /** GitHub provider identity from the existing platform login; never a token. */
  githubIdentity?: GithubAuthIdentity | null;
}

export interface GithubAuthIdentity {
  id: number;
  login: string | null;
}

function positiveInteger(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Extract the stable GitHub account id from Supabase's GitHub OAuth identity. */
export function extractGithubAuthIdentity(
  user: Pick<User, "identities" | "user_metadata"> | null,
): GithubAuthIdentity | null {
  const identity = user?.identities?.find(
    (entry) => entry.provider === "github",
  );
  if (!identity) {
    return null;
  }
  const data = identity.identity_data ?? {};
  const id =
    positiveInteger(data.provider_id) ??
    positiveInteger(data.sub) ??
    positiveInteger(user?.user_metadata?.provider_id) ??
    positiveInteger(user?.user_metadata?.sub);
  if (!id) {
    return null;
  }
  const loginCandidates = [
    data.user_name,
    data.preferred_username,
    data.login,
    user?.user_metadata?.user_name,
    user?.user_metadata?.preferred_username,
  ];
  const login =
    loginCandidates.find(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    )?.trim() ?? null;
  return { id, login };
}

export class UnauthenticatedError extends Error {
  constructor() {
    super("Authentication required");
    this.name = "UnauthenticatedError";
  }
}

/**
 * Resolve the authenticated user for session-scoped API routes.
 *
 * Reads the Supabase JWT from cookies, with a configured dev user fallback
 * for headless CLI calls.
 */
export async function getSessionAuthContext(
  request?: Request,
): Promise<SessionAuthContext> {
  void request;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return {
    userId: user?.id ?? getDevUserId() ?? null,
    githubIdentity: extractGithubAuthIdentity(user),
  };
}

/**
 * Require a logged-in Supabase user.
 * Throws `UnauthenticatedError` (maps to HTTP 401).
 */
export async function requireSessionAuth(
  request?: Request,
): Promise<SessionAuthContext & { userId: string }> {
  const auth = await getSessionAuthContext(request);

  if (!auth.userId) {
    throw new UnauthenticatedError();
  }

  return auth as SessionAuthContext & { userId: string };
}

/** Throws when the session belongs to a different user. */
export function assertSessionOwner(
  sessionUserId: UserId,
  auth: SessionAuthContext,
): void {
  // Trusted server context (workflow steps, CLI) — no user cookie available.
  if (auth.userId === null) {
    return;
  }

  if (sessionUserId !== auth.userId) {
    throw new SessionAccessDeniedError();
  }
}

export class SessionAccessDeniedError extends Error {
  constructor() {
    super("Session access denied");
    this.name = "SessionAccessDeniedError";
  }
}
