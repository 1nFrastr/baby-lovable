import { getRun } from "workflow/api";
import type { UIMessage } from "ai";

import { checkpointSessionTurn } from "@/lib/git/checkpoint-session-turn";
import type { SessionAuthContext } from "@/lib/session/auth-context";
import { deleteDraft, readDraft } from "@/lib/session/draft-store";
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
  pickCancelledAssistantSnapshot,
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
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") {
    return [...messages.slice(0, -1), assistant];
  }
  return [...messages, assistant];
}

/**
 * Persist the in-flight draft (and optional client SSE snapshot) as a cancelled
 * assistant turn and unlock the session. Caller cancels the Workflow run after.
 */
export async function persistCancelledSessionTurn(options: {
  session: Session;
  runId: string | null;
  auth?: SessionAuthContext;
  /** Live useChat assistant — often ahead of the draft materializer. */
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
  const draft = runId ? await readDraft(session.id, auth.userId) : null;
  const draftMatchesRun = Boolean(draft && draft.runId === runId);
  const assistant = pickCancelledAssistantSnapshot([
    draftMatchesRun ? draft?.message : null,
    clientAssistant,
  ]);
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
  await deleteDraft(session.id, auth.userId);

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
 *
 * If the workflow run id is already on the session, cancel that run and
 * persist the draft. If the POST /chat has not recorded lastRunId yet, mark
 * the session cancelled so the in-flight start path discards the new run.
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

  // Composer sent a message but POST /chat has not stored lastRunId yet
  // (`pending` claim, or the previous turn's terminal status). Still seal a
  // client snapshot when present so the next turn does not see "Editing…".
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