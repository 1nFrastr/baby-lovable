import path from "node:path";

const DATA_ROOT = process.env.BABY_LOVABLE_DATA_DIR ?? ".baby-lovable";

export function getSessionRoot(sessionId: string): string {
  return path.join(process.cwd(), DATA_ROOT, "sessions", sessionId);
}

export function getWorkspaceRoot(sessionId: string): string {
  return path.join(getSessionRoot(sessionId), "workspace");
}

export function resolveWorkspacePath(sessionId: string, targetPath: string): string {
  const workspaceRoot = path.resolve(getWorkspaceRoot(sessionId));
  const resolved = path.resolve(workspaceRoot, targetPath);

  if (
    resolved !== workspaceRoot &&
    !resolved.startsWith(`${workspaceRoot}${path.sep}`)
  ) {
    throw new Error(`Path escapes workspace: ${targetPath}`);
  }

  return resolved;
}
