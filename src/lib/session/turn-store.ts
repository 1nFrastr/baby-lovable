import type { UIMessage } from "ai";

import type { ToolProgressEvent } from "@/lib/chat/turn-progress";

import type { SessionAuthContext } from "./auth-context";
import {
  assertSessionTurnActiveSupabase,
  attachSessionRunSupabase,
  beginSessionTurnCancellationSupabase,
  claimSessionTurnSupabase,
  failSessionTurnSupabase,
  finalizeSessionTurnCancellationSupabase,
  finishSessionTurnSupabase,
  persistSessionStepSnapshotSupabase,
  persistSessionToolProgressSupabase,
} from "./turn-store-supabase";

export type {
  ClaimTurnResult,
  TurnMutationResult,
} from "./turn-store-supabase";

export async function claimSessionTurn(
  input: {
    sessionId: string;
    turnId: string;
    assistantMessageId: string;
    userMessage: UIMessage;
  },
  auth: SessionAuthContext,
) {
  return claimSessionTurnSupabase(input, auth);
}

export async function attachSessionRun(
  sessionId: string,
  turnId: string,
  runId: string,
  auth: SessionAuthContext,
) {
  return attachSessionRunSupabase(sessionId, turnId, runId, auth);
}

export async function persistSessionToolProgress(
  sessionId: string,
  turnId: string,
  assistantMessageId: string,
  event: ToolProgressEvent,
) {
  return persistSessionToolProgressSupabase(
    sessionId,
    turnId,
    assistantMessageId,
    event,
  );
}

export async function persistSessionStepSnapshot(
  sessionId: string,
  turnId: string,
  checkpoint: number,
  snapshot: UIMessage,
) {
  return persistSessionStepSnapshotSupabase(
    sessionId,
    turnId,
    checkpoint,
    snapshot,
  );
}

export async function finishSessionTurn(
  sessionId: string,
  turnId: string,
  checkpoint: number,
  snapshot: UIMessage,
) {
  return finishSessionTurnSupabase(
    sessionId,
    turnId,
    checkpoint,
    snapshot,
  );
}

export async function beginSessionTurnCancellation(
  sessionId: string,
  auth: SessionAuthContext,
  expectedTurnId?: string,
) {
  return beginSessionTurnCancellationSupabase(
    sessionId,
    auth,
    expectedTurnId,
  );
}

export async function finalizeSessionTurnCancellation(
  sessionId: string,
  turnId: string,
  clientSnapshot: UIMessage | null,
  auth: SessionAuthContext,
) {
  return finalizeSessionTurnCancellationSupabase(
    sessionId,
    turnId,
    clientSnapshot,
    auth,
  );
}

export async function failSessionTurn(
  sessionId: string,
  turnId: string,
) {
  return failSessionTurnSupabase(sessionId, turnId);
}

export async function assertSessionTurnActive(
  sessionId: string,
  turnId: string,
) {
  return assertSessionTurnActiveSupabase(sessionId, turnId);
}
