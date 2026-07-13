import path from "node:path";

/**
 * Local data root for session files / app-test artifacts (local CLI/debug).
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
 * Root directory for all sessions of a user.
 * Anonymous dev mode (`userId === null`) uses the flat `sessions/` layout.
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

export function getWorkspaceRoot(
  sessionId: string,
  userId: string | null = null,
): string {
  return path.join(getSessionRoot(sessionId, userId), "workspace");
}

export function resolveWorkspacePath(
  sessionId: string,
  targetPath: string,
  userId: string | null = null,
): string {
  const workspaceRoot = path.resolve(getWorkspaceRoot(sessionId, userId));
  const resolved = path.resolve(workspaceRoot, targetPath);

  if (
    resolved !== workspaceRoot &&
    !resolved.startsWith(`${workspaceRoot}${path.sep}`)
  ) {
    throw new Error(`Path escapes workspace: ${targetPath}`);
  }

  return resolved;
}
