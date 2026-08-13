import type { Sandbox } from "@daytona/sdk";

/** Resolve the newest active command and reject stale persisted ids. */
export async function resolveDevCmdId(
  sandbox: Sandbox,
  sessionName: string,
  persistedCmdId: string | null,
): Promise<string | null> {
  try {
    const session = await sandbox.process.getSession(sessionName);
    const commands = session.commands ?? [];
    if (commands.length === 0) {
      return null;
    }

    const ids = commands
      .map((command) => command.id)
      .filter((id): id is string => Boolean(id));
    const ordered = [
      ...(persistedCmdId && ids.includes(persistedCmdId)
        ? [persistedCmdId]
        : []),
      ...[...ids].reverse().filter((id) => id !== persistedCmdId),
    ];

    for (const id of ordered) {
      try {
        const command = await sandbox.process.getSessionCommand(sessionName, id);
        if (command.exitCode == null) {
          return id;
        }
      } catch {
        // A command present in the current session may briefly lack metadata
        // while Daytona is attaching. The newest listed command is still a
        // better identity than a persisted id absent from the session.
        if (id === ids[ids.length - 1]) {
          return id;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}
