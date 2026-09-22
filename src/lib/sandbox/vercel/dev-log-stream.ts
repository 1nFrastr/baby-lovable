import type { DevLogStreamEvent } from "../daytona/dev-log-stream";
import { asVercelProject } from "./provider";
import type { ProjectSandbox } from "../types";

export async function streamVercelDevLogs(
  project: ProjectSandbox,
  cmdId: string,
  onEvent: (event: DevLogStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return;
  }

  const vercel = asVercelProject(project);
  let command;
  try {
    command = await vercel.sdkSandbox.getCommand(cmdId);
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
    stdout: "",
    stderr: "",
  });

  if (signal.aborted) {
    return;
  }

  try {
    for await (const log of command.logs({ signal })) {
      if (signal.aborted) {
        return;
      }
      if (!log?.data) {
        continue;
      }
      onEvent({
        type: "chunk",
        stream: log.stream === "stderr" ? "stderr" : "stdout",
        text: log.data,
      });
    }
  } catch (error) {
    if (signal.aborted) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    onEvent({ type: "error", message });
  }
}

export async function resolveVercelDevCmdId(
  project: ProjectSandbox,
  persistedCmdId: string | null,
): Promise<string | null> {
  if (!persistedCmdId) {
    return null;
  }
  try {
    const command = await asVercelProject(project).sdkSandbox.getCommand(
      persistedCmdId,
    );
    if (command.exitCode == null) {
      return persistedCmdId;
    }
    return null;
  } catch {
    return null;
  }
}
