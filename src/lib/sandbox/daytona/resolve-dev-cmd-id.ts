import type { Sandbox } from "@daytona/sdk";

/**
 * Prefer persisted cmdId; otherwise take the latest command on the preview session.
 */
export async function resolveDevCmdId(
  sandbox: Sandbox,
  sessionName: string,
  persistedCmdId: string | null,
): Promise<string | null> {
  if (persistedCmdId) {
    return persistedCmdId;
  }

  try {
    const session = await sandbox.process.getSession(sessionName);
    const commands = session.commands ?? [];
    if (commands.length === 0) {
      return null;
    }
    return commands[commands.length - 1]?.id ?? null;
  } catch {
    return null;
  }
}
