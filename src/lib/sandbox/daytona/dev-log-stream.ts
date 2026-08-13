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
 * Daytona follow may replay the complete command history from byte zero.
 * Consume that replay incrementally, including when it arrives in many chunks.
 */
function createSnapshotReplayFilter(snapshot: string) {
  let offset = 0;
  let filtering = snapshot.length > 0;

  return (chunk: string): string => {
    // Daytona's callback transport can leak STX frame separators between
    // chunks. They are not command output and would break replay matching.
    const cleanChunk = chunk.replaceAll("\u0002", "");
    if (!filtering || !cleanChunk) {
      return cleanChunk;
    }

    let consumed = 0;
    while (
      consumed < cleanChunk.length &&
      offset < snapshot.length &&
      cleanChunk[consumed] === snapshot[offset]
    ) {
      consumed += 1;
      offset += 1;
    }

    if (consumed === 0) {
      filtering = false;
      return cleanChunk;
    }
    if (offset >= snapshot.length || consumed < cleanChunk.length) {
      filtering = false;
    }
    return cleanChunk.slice(consumed);
  };
}

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

  const filterStdoutReplay = createSnapshotReplayFilter(snapshot.stdout ?? "");
  const filterStderrReplay = createSnapshotReplayFilter(snapshot.stderr ?? "");

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
          const text = filterStdoutReplay(chunk);
          if (text) {
            onEvent({ type: "chunk", stream: "stdout", text });
          }
        },
        (chunk) => {
          if (signal.aborted || !chunk) {
            return;
          }
          const text = filterStderrReplay(chunk);
          if (text) {
            onEvent({ type: "chunk", stream: "stderr", text });
          }
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
