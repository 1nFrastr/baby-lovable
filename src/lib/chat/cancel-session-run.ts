import { getRun } from "workflow/api";
import type { UIMessage } from "ai";

import { checkpointSessionTurn } from "@/lib/git/checkpoint-session-turn";
import {
  lastAssistantMessage,
  mergeAssistantMonotonically,
  upsertAssistantInMessages,
} from "@/lib/chat/assistant-merge";
import type { SessionAuthContext } from "@/lib/session/auth-context";
import {
  getSession,
  replaceMessages,
  updateSession,
} from "@/lib/session/store";
import {
  isActiveRunStatus,
  type Session,
  type SessionRunStatus,
} from "@/lib/session/types";

import {
  assistantHasPersistedContent,
  finalizeInterruptedAssistant,
} from "./interrupt-assistant";

export type CancelSessionRunResult = {
  ok: true;
  runStatus: SessionRunStatus;
  cancelledRunId: string | null;
  persistedAssistant: boolean;
};

export async function cancelWorkflowRun(runId: string): Promise<void> {
  const run = await getRun(runId);
  await run.cancel();
}

function mergeCancelledAssistant(
  messages: UIMessage[],
  assistant: UIMessage,
): UIMessage[] {
  const existing = lastAssistantMessage(messages);
  if (existing) {
    const merged = finalizeInterruptedAssistant(
      mergeAssistantMonotonically(existing, assistant),
    );
    return upsertAssistantInMessages(messages, merged);
  }
  return [...messages, finalizeInterruptedAssistant(assistant)];
}

/**
 * Persist the in-flight authoritative assistant (and optional client SSE
 * snapshot) as a cancelled turn and unlock the session.
 */
export async function persistCancelledSessionTurn(options: {
  session: Session;
  runId: string | null;
  auth?: SessionAuthContext;
  /** Live useChat assistant — may carry unpersisted streaming text. */
  clientAssistant?: UIMessage | null;
}): Promise<{
  session: Session;
  persistedAssistant: boolean;
}> {
  const {
    session,
    runId,
    auth = { userId: session.userId },
    clientAssistant = null,
  } = options;

  const authoritative = lastAssistantMessage(session.messages);
  let assistant: UIMessage | null = authoritative ?? null;

  if (clientAssistant && clientAssistant.role === "assistant") {
    const finalizedClient = finalizeInterruptedAssistant(clientAssistant);
    assistant = authoritative
      ? mergeAssistantMonotonically(authoritative, finalizedClient)
      : finalizedClient;
  } else if (assistant) {
    assistant = finalizeInterruptedAssistant(assistant);
  }

  const persistedAssistant = Boolean(
    assistant && assistantHasPersistedContent(assistant),
  );
  const messages =
    persistedAssistant && assistant
      ? mergeCancelledAssistant(session.messages, assistant)
      : session.messages;

  if (persistedAssistant) {
    await replaceMessages(session.id, messages, auth);
  }

  const updated = await updateSession(
    session.id,
    {
      runStatus: "cancelled",
      lastRunId: null,
    },
    auth,
  );

  await checkpointSessionTurn({
    sessionId: session.id,
    messages,
    outcome: "cancelled",
    runId,
    userId: auth.userId ?? session.userId,
    sessionTitle: session.title,
  });

  return { session: updated, persistedAssistant };
}

/**
 * Stop an in-flight builder chat turn.
 */
export async function cancelSessionRun(
  sessionId: string,
  auth: SessionAuthContext,
  options: { clientAssistant?: UIMessage | null } = {},
): Promise<CancelSessionRunResult | { ok: false; error: string; status: number }> {
  const session = await getSession(sessionId, auth);
  if (!session) {
    return { ok: false, error: "Session not found", status: 404 };
  }

  if (isActiveRunStatus(session.runStatus) && session.lastRunId) {
    const runId = session.lastRunId;
    const { persistedAssistant } = await persistCancelledSessionTurn({
      session,
      runId,
      auth,
      clientAssistant: options.clientAssistant,
    });
    try {
      await cancelWorkflowRun(runId);
    } catch (error) {
      console.error(
        `[chat] cancel workflow failed session=${sessionId} run=${runId}:`,
        error,
      );
    }
    return {
      ok: true,
      runStatus: "cancelled",
      cancelledRunId: runId,
      persistedAssistant,
    };
  }

  if (session.runStatus === "cancelled") {
    return {
      ok: true,
      runStatus: "cancelled",
      cancelledRunId: session.lastRunId ?? null,
      persistedAssistant: false,
    };
  }

  if (options.clientAssistant) {
    const { persistedAssistant } = await persistCancelledSessionTurn({
      session,
      runId: session.lastRunId ?? null,
      auth,
      clientAssistant: options.clientAssistant,
    });
    return {
      ok: true,
      runStatus: "cancelled",
      cancelledRunId: null,
      persistedAssistant,
    };
  }

  await updateSession(
    sessionId,
    { runStatus: "cancelled", lastRunId: null },
    auth,
  );
  return {
    ok: true,
    runStatus: "cancelled",
    cancelledRunId: null,
    persistedAssistant: false,
  };
}
