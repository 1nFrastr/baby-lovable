import type { UserId } from "./types";

export interface SessionAuthContext {
  /** `null` = anonymous local-dev; future: Supabase `auth.users.id`. */
  userId: UserId;
}

/**
 * Resolve the authenticated user for session-scoped API routes.
 *
 * Supabase is not wired yet — returns anonymous context. When auth lands,
 * extract the JWT here and map to `userId`.
 */
export async function getSessionAuthContext(
  request?: Request,
): Promise<SessionAuthContext> {
  void request;
  return { userId: null };
}

/** Throws when the session belongs to a different user. */
export function assertSessionOwner(
  sessionUserId: UserId,
  auth: SessionAuthContext,
): void {
  if (sessionUserId === null && auth.userId === null) {
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
