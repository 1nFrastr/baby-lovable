/**
 * Durable step: attach sandbox → commit → push for one turn.
 * Soft errors throw so Workflow retries; conflict / exhausted end cleanly.
 */
export async function gitTurnCheckpointStep(
  sessionId: string,
  runId: string,
  userId: string | null,
): Promise<{ status: string }> {
  "use step";

  const { runTurnCheckpoint } = await import("@/lib/git/turn-sync");
  const { getOrCreateDaytonaSandbox } = await import(
    "@/lib/sandbox/daytona/sandbox"
  );
  const project = await getOrCreateDaytonaSandbox(sessionId);
  const task = await runTurnCheckpoint(
    sessionId,
    runId,
    project,
    userId,
    `wf_${runId}`,
  );

  if (task.status === "conflict") {
    return { status: task.status };
  }
  if (task.status === "synced" || task.status === "no_changes") {
    return { status: task.status };
  }
  if (task.status === "error" && task.attemptCount >= 5) {
    return { status: task.status };
  }
  if (task.status === "error") {
    throw new Error(task.lastError ?? "Freestyle turn checkpoint failed");
  }
  // syncing / pending — another worker holds the lease; end without error.
  return { status: task.status };
}
