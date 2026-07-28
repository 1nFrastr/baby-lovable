import type { UIMessage } from "ai";

import { deriveTurnCommitInput } from "@/lib/git/commit-message";
import { newLocalCheckpointRunId } from "@/lib/git/provision-repo";
import { enqueueTurnCheckpoint } from "@/lib/git/turn-sync";
import type { GitTurnOutcome } from "@/lib/git/types";

/**
 * Shared Web/CLI entry: enqueue turn checkpoint and kick durable worker.
 * Does not wait for commit/push — chat unlocks immediately.
 * Local sandbox mode is a no-op (workspace stays on disk only).
 */
export async function checkpointSessionTurn(input: {
  sessionId: string;
  sandboxMode: "local" | "daytona";
  messages: UIMessage[];
  outcome: GitTurnOutcome;
  runId?: string | null;
  userId?: string | null;
  sessionTitle?: string;
}): Promise<{ ran: boolean; runId?: string; workflowRunId?: string | null }> {
  if (input.sandboxMode !== "daytona") {
    return { ran: false };
  }

  const { getSession } = await import("@/lib/session/store");
  const session = await getSession(input.sessionId);
  if (!session) {
    throw new Error(`Session not found: ${input.sessionId}`);
  }

  const runId =
    input.runId ||
    session.lastRunId ||
    newLocalCheckpointRunId();

  const { commitMessage } = deriveTurnCommitInput(
    { id: session.id, title: input.sessionTitle ?? session.title },
    input.messages,
    runId,
    input.outcome,
  );

  await enqueueTurnCheckpoint({
    sessionId: session.id,
    runId,
    outcome: input.outcome,
    commitMessage,
    userId: input.userId ?? session.userId,
  });

  const { kickGitTurnCheckpointWorkflow } = await import(
    "@/workflow/git-turn-checkpoint-kick"
  );
  const workflowRunId = await kickGitTurnCheckpointWorkflow(
    session.id,
    runId,
    input.userId ?? session.userId,
  );

  return { ran: true, runId, workflowRunId };
}
