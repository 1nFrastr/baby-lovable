import path from "node:path";

const DATA_ROOT = process.env.BABY_LOVABLE_DATA_DIR ?? ".baby-lovable";

/**
 * Root directory for all sessions of a user.
 * Anonymous dev mode (`userId === null`) uses the flat `sessions/` layout.
 */
export function getSessionsRoot(userId: string | null = null): string {
  if (userId) {
    return path.join(process.cwd(), DATA_ROOT, "users", userId, "sessions");
  }

  return path.join(process.cwd(), DATA_ROOT, "sessions");
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
