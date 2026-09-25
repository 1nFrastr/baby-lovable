import type { UIMessage } from "ai";

import { isDaytonaFreePlan } from "@/lib/features/daytona-free-plan";
import { deriveTurnCommitInput } from "@/lib/git/commit-message";
import { newLocalCheckpointRunId } from "@/lib/git/provision-repo";
import { enqueueTurnCheckpoint } from "@/lib/git/turn-sync";
import type { GitTurnOutcome } from "@/lib/git/types";

/**
 * Shared Web/CLI entry: enqueue turn checkpoint and kick durable worker.
 * Does not wait for commit/push — chat unlocks immediately.
 * No-op only for Daytona sessions on DAYTONA_FREE_PLAN. Vercel always checkpoints.
 */
export async function checkpointSessionTurn(input: {
  sessionId: string;
  messages: UIMessage[];
  outcome: GitTurnOutcome;
  runId?: string | null;
  userId?: string | null;
  sessionTitle?: string;
}): Promise<{ ran: boolean; runId?: string; workflowRunId?: string | null }> {
  const { getSessionMeta } = await import("@/lib/session/store");
  const session = await getSessionMeta(input.sessionId);
  if (!session) {
    throw new Error(`Session not found: ${input.sessionId}`);
  }
  if (isDaytonaFreePlan(session.sandboxMode)) {
    return { ran: false };
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
