import type { UIMessage } from "ai";

import type { ToolProgressEvent } from "@/lib/chat/turn-progress";

export async function assertActiveTurnStep(
  sessionId: string,
  turnId: string,
) {
  "use step";

  const { assertSessionTurnActive } = await import(
    "@/lib/session/turn-store"
  );
  await assertSessionTurnActive(sessionId, turnId);
}

export async function persistToolProgressStep(
  sessionId: string,
  turnId: string,
  assistantMessageId: string,
  event: ToolProgressEvent,
) {
  "use step";

  const { persistSessionToolProgress } = await import(
    "@/lib/session/turn-store"
  );
  return persistSessionToolProgress(
    sessionId,
    turnId,
    assistantMessageId,
    event,
  );
}

export async function persistStepSnapshotStep(
  sessionId: string,
  turnId: string,
  checkpoint: number,
  snapshot: UIMessage,
) {
  "use step";

  const { persistSessionStepSnapshot } = await import(
    "@/lib/session/turn-store"
  );
  return persistSessionStepSnapshot(
    sessionId,
    turnId,
    checkpoint,
    snapshot,
  );
}

export async function finishTurnStep(
  sessionId: string,
  turnId: string,
  checkpoint: number,
  snapshot: UIMessage,
) {
  "use step";

  const { finishSessionTurn } = await import("@/lib/session/turn-store");
  const result = await finishSessionTurn(
    sessionId,
    turnId,
    checkpoint,
    snapshot,
  );
  if (!result.ok || !result.changed) {
    return result;
  }

  const { checkpointSessionTurn } = await import(
    "@/lib/git/checkpoint-session-turn"
  );
  await checkpointSessionTurn({
    sessionId,
    messages: result.session.messages,
    outcome: "completed",
    runId: turnId,
    userId: result.session.userId,
    sessionTitle: result.session.title,
  });
  return result;
}

export async function failTurnStep(
  sessionId: string,
  turnId: string,
) {
  "use step";

  const { failSessionTurn } = await import("@/lib/session/turn-store");
  const result = await failSessionTurn(sessionId, turnId);
  if (!result.ok || !result.changed) {
    return result;
  }

  const { checkpointSessionTurn } = await import(
    "@/lib/git/checkpoint-session-turn"
  );
  await checkpointSessionTurn({
    sessionId,
    messages: result.session.messages,
    outcome: "failed",
    runId: turnId,
    userId: result.session.userId,
    sessionTitle: result.session.title,
  });
  return result;
}
