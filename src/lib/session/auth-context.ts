import type { UserId } from "./types";
import { getDevUserId, isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface SessionAuthContext {
  /** `null` = anonymous local-dev; Supabase `auth.users.id` when configured. */
  userId: UserId;
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
 * When Supabase is configured (via Vercel Marketplace env sync), reads the
 * JWT from cookies. Otherwise returns anonymous context for local file mode.
 */
export async function getSessionAuthContext(
  request?: Request,
): Promise<SessionAuthContext> {
  void request;

  if (!isSupabaseConfigured()) {
    return { userId: null };
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return { userId: user?.id ?? getDevUserId() ?? null };
}

/**
 * Require a logged-in user when Supabase is active.
 * Throws `UnauthenticatedError` (maps to HTTP 401).
 */
export async function requireSessionAuth(
  request?: Request,
): Promise<SessionAuthContext & { userId: string }> {
  const auth = await getSessionAuthContext(request);

  if (isSupabaseConfigured() && !auth.userId) {
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
  if (isSupabaseConfigured() && auth.userId === null) {
    return;
  }

  if (!isSupabaseConfigured()) {
    if (sessionUserId === null && auth.userId === null) {
      return;
    }
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
