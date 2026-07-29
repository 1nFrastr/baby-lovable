import type { Sandbox } from "@daytona/sdk";

export type DevLogStreamEvent =
  | {
      type: "meta";
      generation: number;
      cmdId: string;
      sessionName: string;
    }
  | {
      type: "snapshot";
      stdout: string;
      stderr: string;
    }
  | {
      type: "chunk";
      stream: "stdout" | "stderr";
      text: string;
    }
  | { type: "waiting"; reason: string }
  | { type: "stale"; reason: string }
  | { type: "error"; message: string };

/**
 * Snapshot + follow Daytona session command logs until abort or stream end.
 * On abort, callbacks stop; the SDK WebSocket is best-effort (no public close API).
 */
export async function streamDevCommandLogs(
  sandbox: Sandbox,
  sessionName: string,
  cmdId: string,
  onEvent: (event: DevLogStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return;
  }

  let snapshot;
  try {
    snapshot = await sandbox.process.getSessionCommandLogs(sessionName, cmdId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onEvent({
      type: "stale",
      reason: `Failed to read command logs: ${message}`,
    });
    return;
  }

  onEvent({
    type: "snapshot",
    stdout: snapshot.stdout ?? "",
    stderr: snapshot.stderr ?? "",
  });

  if (signal.aborted) {
    return;
  }

  try {
    const command = await sandbox.process.getSessionCommand(sessionName, cmdId);
    if (command.exitCode != null) {
      onEvent({
        type: "stale",
        reason: `Dev command exited with code ${command.exitCode}`,
      });
      return;
    }
  } catch {
    // Command metadata may be unavailable while still streaming; continue follow.
  }

  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (err !== undefined) {
        reject(err);
      } else {
        resolve();
      }
    };

    const onAbort = () => finish();

    if (signal.aborted) {
      finish();
      return;
    }
    signal.addEventListener("abort", onAbort);

    sandbox.process
      .getSessionCommandLogs(
        sessionName,
        cmdId,
        (chunk) => {
          if (signal.aborted || !chunk) {
            return;
          }
          onEvent({ type: "chunk", stream: "stdout", text: chunk });
        },
        (chunk) => {
          if (signal.aborted || !chunk) {
            return;
          }
          onEvent({ type: "chunk", stream: "stderr", text: chunk });
        },
      )
      .then(() => finish())
      .catch((error: unknown) => {
        if (signal.aborted) {
          finish();
          return;
        }
        finish(error);
      });
  });
}
