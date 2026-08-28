import type { UIMessage } from "ai";

import {
  applyAssistantSnapshot,
  applyToolProgress,
  createTurnAssistantMessage,
  finalizeTurnForCancellation,
  getTurnAssistant,
  type ToolProgressEvent,
} from "@/lib/chat/turn-progress";
import {
  assistantHasPersistedContent,
  finalizeInterruptedAssistant,
} from "@/lib/chat/interrupt-assistant";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

import type { SessionAuthContext } from "./auth-context";
import {
  getSessionSupabase,
  rowToSession,
  type SessionRow,
} from "./store-supabase";
import {
  isActiveRunStatus,
  type Session,
  type SessionRunStatus,
} from "./types";
import { SESSION_SCHEMA_VERSION } from "./types";

const MAX_CAS_ATTEMPTS = 12;

type CasPatch = Record<string, unknown>;

export type ClaimTurnResult =
  | { ok: true; session: Session; claimed: true }
  | {
      ok: false;
      reason: "active_turn" | "duplicate_user_message" | "not_found";
      session: Session | null;
    };

export type TurnMutationResult =
  | { ok: true; session: Session; changed: boolean }
  | {
      ok: false;
      reason: "stale_turn" | "not_found" | "not_active";
      session: Session | null;
    };

function titleFromFirstUser(messages: UIMessage[]): string | null {
  const firstUser = messages.find((message) => message.role === "user");
  const text = firstUser?.parts.find((part) => part.type === "text");
  if (!text || text.type !== "text") {
    return null;
  }
  const trimmed = text.text.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
}

async function casSessionRow(options: {
  current: Session;
  patch: CasPatch;
  expectedTurnId: string | null;
}): Promise<Session | null> {
  const { current, patch, expectedTurnId } = options;
  const nextRevision = current.conversationRevision + 1;
  const supabase = getSupabaseAdminClient();

  let query = supabase
    .from("sessions")
    .update({
      ...patch,
      schema_version: SESSION_SCHEMA_VERSION,
      conversation_revision: nextRevision,
      updated_at: new Date().toISOString(),
    })
    .eq("id", current.id)
    .eq("conversation_revision", current.conversationRevision);

  query =
    expectedTurnId === null
      ? query.is("active_turn_id", null)
      : query.eq("active_turn_id", expectedTurnId);

  const { data, error } = await query.select("*").maybeSingle();
  if (error) {
    throw new Error(`Failed to update session turn: ${error.message}`);
  }
  return data ? rowToSession(data as SessionRow) : null;
}

function terminalPatch(
  status: Extract<SessionRunStatus, "completed" | "failed" | "cancelled">,
  messages: UIMessage[],
  checkpoint: number,
): CasPatch {
  return {
    messages,
    run_status: status,
    last_run_id: null,
    active_turn_id: null,
    active_assistant_message_id: null,
    active_turn_started_at: null,
    turn_checkpoint: checkpoint,
  };
}

function removeAssistantMessage(
  messages: UIMessage[],
  assistantMessageId: string,
): UIMessage[] {
  return messages.filter((message) => message.id !== assistantMessageId);
}

function sameMessages(left: UIMessage[], right: UIMessage[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function claimSessionTurnSupabase(
  input: {
    sessionId: string;
    turnId: string;
    assistantMessageId: string;
    userMessage: UIMessage;
  },
  auth: SessionAuthContext = { userId: null },
): Promise<ClaimTurnResult> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = await getSessionSupabase(input.sessionId, auth);
    if (!current) {
      return { ok: false, reason: "not_found", session: null };
    }

    if (current.activeTurnId || isActiveRunStatus(current.runStatus)) {
      return {
        ok: false,
        reason: "active_turn",
        session: current,
      };
    }

    if (
      current.messages.some(
        (message) => message.id === input.userMessage.id,
      )
    ) {
      return {
        ok: false,
        reason: "duplicate_user_message",
        session: current,
      };
    }

    const messages = [
      ...current.messages,
      input.userMessage,
      createTurnAssistantMessage(input.assistantMessageId),
    ];
    const title =
      current.title === "New Project"
        ? (titleFromFirstUser(messages) ?? current.title)
        : current.title;
    const startedAt = new Date().toISOString();
    const updated = await casSessionRow({
      current,
      expectedTurnId: null,
      patch: {
        messages,
        title,
        run_status: "pending",
        last_run_id: null,
        active_turn_id: input.turnId,
        active_assistant_message_id: input.assistantMessageId,
        active_turn_started_at: startedAt,
        turn_checkpoint: -1,
      },
    });
    if (updated) {
      return { ok: true, claimed: true, session: updated };
    }
  }

  throw new Error(
    `Failed to claim session turn after ${MAX_CAS_ATTEMPTS} CAS attempts`,
  );
}

export async function attachSessionRunSupabase(
  sessionId: string,
  turnId: string,
  runId: string,
  auth: SessionAuthContext = { userId: null },
): Promise<TurnMutationResult> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = await getSessionSupabase(sessionId, auth);
    if (!current) {
      return { ok: false, reason: "not_found", session: null };
    }
    if (current.activeTurnId !== turnId) {
      return {
        ok: false,
        reason: "stale_turn",
        session: current,
      };
    }

    if (current.lastRunId === runId) {
      return { ok: true, session: current, changed: false };
    }

    const nextStatus =
      current.runStatus === "cancelling" ? "cancelling" : "running";
    const updated = await casSessionRow({
      current,
      expectedTurnId: turnId,
      patch: {
        last_run_id: runId,
        run_status: nextStatus,
      },
    });
    if (updated) {
      return { ok: true, session: updated, changed: true };
    }
  }

  throw new Error(
    `Failed to attach workflow run after ${MAX_CAS_ATTEMPTS} CAS attempts`,
  );
}

export async function persistSessionToolProgressSupabase(
  sessionId: string,
  turnId: string,
  assistantMessageId: string,
  event: ToolProgressEvent,
): Promise<TurnMutationResult> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = await getSessionSupabase(sessionId);
    if (!current) {
      return { ok: false, reason: "not_found", session: null };
    }
    if (
      current.activeTurnId !== turnId ||
      current.activeAssistantMessageId !== assistantMessageId
    ) {
      return {
        ok: false,
        reason: "stale_turn",
        session: current,
      };
    }
    if (!isActiveRunStatus(current.runStatus)) {
      return {
        ok: false,
        reason: "not_active",
        session: current,
      };
    }

    const messages = applyToolProgress(
      current.messages,
      assistantMessageId,
      event,
    );
    if (sameMessages(messages, current.messages)) {
      return { ok: true, session: current, changed: false };
    }
    const updated = await casSessionRow({
      current,
      expectedTurnId: turnId,
      patch: { messages },
    });
    if (updated) {
      return { ok: true, session: updated, changed: true };
    }
  }

  throw new Error(
    `Failed to persist tool progress after ${MAX_CAS_ATTEMPTS} CAS attempts`,
  );
}

export async function persistSessionStepSnapshotSupabase(
  sessionId: string,
  turnId: string,
  checkpoint: number,
  snapshot: UIMessage,
): Promise<TurnMutationResult> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = await getSessionSupabase(sessionId);
    if (!current) {
      return { ok: false, reason: "not_found", session: null };
    }
    if (
      current.activeTurnId !== turnId ||
      current.activeAssistantMessageId !== snapshot.id
    ) {
      return {
        ok: false,
        reason: "stale_turn",
        session: current,
      };
    }
    if (!isActiveRunStatus(current.runStatus)) {
      return {
        ok: false,
        reason: "not_active",
        session: current,
      };
    }
    if (checkpoint <= current.turnCheckpoint) {
      return { ok: true, session: current, changed: false };
    }

    const messages = applyAssistantSnapshot(current.messages, snapshot);
    const updated = await casSessionRow({
      current,
      expectedTurnId: turnId,
      patch: {
        messages,
        turn_checkpoint: checkpoint,
      },
    });
    if (updated) {
      return { ok: true, session: updated, changed: true };
    }
  }

  throw new Error(
    `Failed to persist step snapshot after ${MAX_CAS_ATTEMPTS} CAS attempts`,
  );
}

export async function finishSessionTurnSupabase(
  sessionId: string,
  turnId: string,
  checkpoint: number,
  snapshot: UIMessage,
): Promise<TurnMutationResult> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = await getSessionSupabase(sessionId);
    if (!current) {
      return { ok: false, reason: "not_found", session: null };
    }
    if (
      current.activeTurnId !== turnId ||
      current.activeAssistantMessageId !== snapshot.id
    ) {
      return {
        ok: false,
        reason: "stale_turn",
        session: current,
      };
    }
    if (current.runStatus === "cancelling") {
      return {
        ok: false,
        reason: "not_active",
        session: current,
      };
    }

    const messages = assistantHasPersistedContent(snapshot)
      ? applyAssistantSnapshot(current.messages, snapshot)
      : removeAssistantMessage(current.messages, snapshot.id);
    const updated = await casSessionRow({
      current,
      expectedTurnId: turnId,
      patch: terminalPatch("completed", messages, checkpoint),
    });
    if (updated) {
      return { ok: true, session: updated, changed: true };
    }
  }

  throw new Error(
    `Failed to finish session turn after ${MAX_CAS_ATTEMPTS} CAS attempts`,
  );
}

export async function beginSessionTurnCancellationSupabase(
  sessionId: string,
  auth: SessionAuthContext = { userId: null },
  expectedTurnId?: string,
): Promise<TurnMutationResult> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = await getSessionSupabase(sessionId, auth);
    if (!current) {
      return { ok: false, reason: "not_found", session: null };
    }
    if (!current.activeTurnId || !isActiveRunStatus(current.runStatus)) {
      return {
        ok: false,
        reason: "not_active",
        session: current,
      };
    }
    if (expectedTurnId && current.activeTurnId !== expectedTurnId) {
      return {
        ok: false,
        reason: "stale_turn",
        session: current,
      };
    }
    if (current.runStatus === "cancelling") {
      return { ok: true, session: current, changed: false };
    }

    const updated = await casSessionRow({
      current,
      expectedTurnId: current.activeTurnId,
      patch: { run_status: "cancelling" },
    });
    if (updated) {
      return { ok: true, session: updated, changed: true };
    }
  }

  throw new Error(
    `Failed to begin cancellation after ${MAX_CAS_ATTEMPTS} CAS attempts`,
  );
}

export async function finalizeSessionTurnCancellationSupabase(
  sessionId: string,
  turnId: string,
  clientSnapshot: UIMessage | null = null,
  auth: SessionAuthContext = { userId: null },
): Promise<TurnMutationResult> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = await getSessionSupabase(sessionId, auth);
    if (!current) {
      return { ok: false, reason: "not_found", session: null };
    }
    if (
      current.activeTurnId !== turnId ||
      !current.activeAssistantMessageId
    ) {
      return {
        ok: false,
        reason: "stale_turn",
        session: current,
      };
    }

    const authoritative = getTurnAssistant(
      current.messages,
      current.activeAssistantMessageId,
    );
    const assistant = finalizeTurnForCancellation(
      authoritative,
      clientSnapshot,
    );
    const messages = assistantHasPersistedContent(assistant)
      ? applyAssistantSnapshot(current.messages, assistant)
      : removeAssistantMessage(
          current.messages,
          current.activeAssistantMessageId,
        );
    const updated = await casSessionRow({
      current,
      expectedTurnId: turnId,
      patch: terminalPatch(
        "cancelled",
        messages,
        current.turnCheckpoint,
      ),
    });
    if (updated) {
      return { ok: true, session: updated, changed: true };
    }
  }

  throw new Error(
    `Failed to finalize cancellation after ${MAX_CAS_ATTEMPTS} CAS attempts`,
  );
}

export async function failSessionTurnSupabase(
  sessionId: string,
  turnId: string,
): Promise<TurnMutationResult> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = await getSessionSupabase(sessionId);
    if (!current) {
      return { ok: false, reason: "not_found", session: null };
    }
    if (
      current.activeTurnId !== turnId ||
      !current.activeAssistantMessageId
    ) {
      return {
        ok: false,
        reason: "stale_turn",
        session: current,
      };
    }
    if (current.runStatus === "cancelling") {
      return {
        ok: false,
        reason: "not_active",
        session: current,
      };
    }

    const assistant = finalizeInterruptedAssistant(
      getTurnAssistant(
        current.messages,
        current.activeAssistantMessageId,
      ),
    );
    const messages = assistantHasPersistedContent(assistant)
      ? applyAssistantSnapshot(current.messages, assistant)
      : removeAssistantMessage(
          current.messages,
          current.activeAssistantMessageId,
        );
    const updated = await casSessionRow({
      current,
      expectedTurnId: turnId,
      patch: terminalPatch("failed", messages, current.turnCheckpoint),
    });
    if (updated) {
      return { ok: true, session: updated, changed: true };
    }
  }

  throw new Error(
    `Failed to mark session turn failed after ${MAX_CAS_ATTEMPTS} CAS attempts`,
  );
}

export async function assertSessionTurnActiveSupabase(
  sessionId: string,
  turnId: string,
): Promise<Session> {
  const session = await getSessionSupabase(sessionId);
  if (
    !session ||
    session.activeTurnId !== turnId ||
    (session.runStatus !== "pending" && session.runStatus !== "running")
  ) {
    throw new Error(`Turn superseded: ${turnId}`);
  }
  return session;
}
