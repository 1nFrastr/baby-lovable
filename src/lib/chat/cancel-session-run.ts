import { getRun } from "workflow/api";
import type { UIMessage } from "ai";

import { checkpointSessionTurn } from "@/lib/git/checkpoint-session-turn";
import type { SessionAuthContext } from "@/lib/session/auth-context";
import { getSession, replaceMessages, updateSession } from "@/lib/session/store";
import {
  beginSessionTurnCancellation,
  finalizeSessionTurnCancellation,
} from "@/lib/session/turn-store";
import {
  isActiveRunStatus,
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

async function workflowIsAlreadyTerminal(runId: string): Promise<boolean> {
  try {
    const run = await getRun(runId);
    const status = await run.status;
    return (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled"
    );
  } catch {
    return false;
  }
}

async function cancelLegacySessionRun(
  sessionId: string,
  auth: SessionAuthContext,
): Promise<
  CancelSessionRunResult | { ok: false; error: string; status: number }
> {
  const session = await getSession(sessionId, auth);
  if (!session) {
    return { ok: false, error: "Session not found", status: 404 };
  }

  const runId = session.lastRunId ?? null;
  if (runId) {
    try {
      await cancelWorkflowRun(runId);
    } catch (error) {
      if (!(await workflowIsAlreadyTerminal(runId))) {
        return {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to cancel workflow",
          status: 503,
        };
      }
    }
  }

  const last = session.messages.at(-1);
  const assistant =
    last?.role === "assistant"
      ? finalizeInterruptedAssistant(last)
      : null;
  const persistedAssistant = Boolean(
    assistant && assistantHasPersistedContent(assistant),
  );
  const messages =
    assistant && persistedAssistant
      ? [...session.messages.slice(0, -1), assistant]
      : session.messages;
  if (messages !== session.messages) {
    await replaceMessages(sessionId, messages, auth);
  }
  await updateSession(
    sessionId,
    { runStatus: "cancelled", lastRunId: null },
    auth,
  );
  return {
    ok: true,
    runStatus: "cancelled",
    cancelledRunId: runId,
    persistedAssistant,
  };
}

/**
 * Stop the active turn under its fencing token. The composer remains locked in
 * `cancelling` until the durable run is cancelled and the authoritative
 * assistant snapshot is atomically sealed.
 */
export async function cancelSessionRun(
  sessionId: string,
  auth: SessionAuthContext,
  options: {
    clientAssistant?: UIMessage | null;
    expectedTurnId?: string;
  } = {},
): Promise<
  CancelSessionRunResult | { ok: false; error: string; status: number }
> {
  const initial = await getSession(sessionId, auth);
  if (!initial) {
    return { ok: false, error: "Session not found", status: 404 };
  }

  if (!initial.activeTurnId) {
    if (isActiveRunStatus(initial.runStatus)) {
      return cancelLegacySessionRun(sessionId, auth);
    }
    if (initial.runStatus === "cancelled") {
      return {
        ok: true,
        runStatus: "cancelled",
        cancelledRunId: null,
        persistedAssistant: false,
      };
    }
    return {
      ok: false,
      error: "No active turn to cancel",
      status: 409,
    };
  }

  const turnId = initial.activeTurnId;
  if (options.expectedTurnId && options.expectedTurnId !== turnId) {
    return {
      ok: false,
      error: "The active turn changed before cancellation",
      status: 409,
    };
  }

  const begun = await beginSessionTurnCancellation(
    sessionId,
    auth,
    turnId,
  );
  if (!begun.ok) {
    if (begun.reason === "not_found") {
      return { ok: false, error: "Session not found", status: 404 };
    }
    if (begun.session?.runStatus === "cancelled") {
      return {
        ok: true,
        runStatus: "cancelled",
        cancelledRunId: null,
        persistedAssistant: false,
      };
    }
    return {
      ok: false,
      error: "The active turn changed before cancellation",
      status: 409,
    };
  }

  const runId = begun.session.lastRunId ?? null;
  if (runId) {
    try {
      await cancelWorkflowRun(runId);
    } catch (error) {
      if (!(await workflowIsAlreadyTerminal(runId))) {
        return {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to cancel workflow",
          status: 503,
        };
      }
    }
  }

  const finalized = await finalizeSessionTurnCancellation(
    sessionId,
    turnId,
    options.clientAssistant ?? null,
    auth,
  );
  if (!finalized.ok) {
    if (finalized.session?.runStatus === "completed") {
      return {
        ok: true,
        runStatus: "completed",
        cancelledRunId: runId,
        persistedAssistant: true,
      };
    }
    return {
      ok: false,
      error: "The turn changed while cancellation was being finalized",
      status: 409,
    };
  }

  const assistant = finalized.session.messages.at(-1);
  const persistedAssistant = Boolean(
    assistant &&
      assistant.role === "assistant" &&
      assistantHasPersistedContent(assistant),
  );

  if (finalized.changed) {
    await checkpointSessionTurn({
      sessionId,
      messages: finalized.session.messages,
      outcome: "cancelled",
      runId: runId ?? turnId,
      userId: finalized.session.userId,
      sessionTitle: finalized.session.title,
    });
  }

  return {
    ok: true,
    runStatus: "cancelled",
    cancelledRunId: runId,
    persistedAssistant,
  };
}
