import path from "node:path";

/**
 * Local artifact root for CLI traces and optional app-test reports.
 * Durable session metadata is stored exclusively in Supabase.
 *
 * - Override with `BABY_LOVABLE_DATA_DIR` (absolute or cwd-relative).
 * - On Vercel/Lambda defaults to `/tmp/baby-lovable` (deploy dir is read-only).
 *   App-test disk writes are usually skipped there via
 *   `shouldPersistAppTestArtifacts()`.
 * - Locally defaults to `.baby-lovable` under `process.cwd()`.
 */
export function getDataRoot(): string {
  const fromEnv = process.env.BABY_LOVABLE_DATA_DIR?.trim();
  if (fromEnv) {
    return path.isAbsolute(fromEnv)
      ? fromEnv
      : path.join(process.cwd(), fromEnv);
  }

  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return path.join("/tmp", "baby-lovable");
  }

  return path.join(process.cwd(), ".baby-lovable");
}

/**
 * Artifact directory for all sessions of a user.
 * Trusted CLI calls without a user id use the flat `sessions/` layout.
 */
export function getSessionsRoot(userId: string | null = null): string {
  if (userId) {
    return path.join(getDataRoot(), "users", userId, "sessions");
  }

  return path.join(getDataRoot(), "sessions");
}

export function resolveSessionRoot(
  sessionId: string,
  userId: string | null = null,
): string {
  return path.join(getSessionsRoot(userId), sessionId);
}

export function getSessionRoot(
  sessionId: string,
  userId: string | null = null,
): string {
  return resolveSessionRoot(sessionId, userId);
}
