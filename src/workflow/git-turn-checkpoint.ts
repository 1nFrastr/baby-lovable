import { gitTurnCheckpointStep } from "./git-turn-checkpoint-steps";

/**
 * Durable per-turn Freestyle checkpoint orchestration.
 * Keep this file free of Node / Daytona / freestyle imports.
 */
export async function gitTurnCheckpointWorkflow(
  sessionId: string,
  runId: string,
  userId: string | null = null,
): Promise<{ status: string }> {
  "use workflow";

  return gitTurnCheckpointStep(sessionId, runId, userId);
}
