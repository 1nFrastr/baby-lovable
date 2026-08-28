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
  hydrateSessionRow,
  rpcClaimSessionTurn,
  rpcTerminalSessionTurn,
  rpcUpdateAssistantMessage,
  sessionMessageExists,
} from "./session-messages";
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

async function sessionFromRow(row: SessionRow): Promise<Session> {
  return rowToSession(await hydrateSessionRow(row));
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
  return data ? sessionFromRow(data as SessionRow) : null;
}

function terminalAssistantMessage(
  messages: UIMessage[],
  snapshot: UIMessage,
): UIMessage | null {
  if (!assistantHasPersistedContent(snapshot)) {
    return null;
  }
  return getTurnAssistant(
    applyAssistantSnapshot(messages, snapshot),
    snapshot.id,
  );
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

    if (await sessionMessageExists(input.sessionId, input.userMessage.id)) {
      return {
        ok: false,
        reason: "duplicate_user_message",
        session: current,
      };
    }

    const title =
      current.title === "New Project"
        ? (titleFromFirstUser([...current.messages, input.userMessage]) ??
          current.title)
        : current.title;
    const startedAt = new Date().toISOString();
    const assistantMessage = createTurnAssistantMessage(
      input.assistantMessageId,
    );
    const row = await rpcClaimSessionTurn({
      sessionId: input.sessionId,
      expectedRevision: current.conversationRevision,
      turnId: input.turnId,
      assistantMessageId: input.assistantMessageId,
      userMessage: input.userMessage,
      assistantMessage,
      title,
      startedAt,
    });
    if (row) {
      return {
        ok: true,
        claimed: true,
        session: await sessionFromRow(row as SessionRow),
      };
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
    const updatedAssistant = getTurnAssistant(messages, assistantMessageId);

    const row = await rpcUpdateAssistantMessage({
      sessionId,
      expectedRevision: current.conversationRevision,
      turnId,
      assistantMessageId,
      message: updatedAssistant,
    });
    if (row) {
      return {
        ok: true,
        session: await sessionFromRow(row as SessionRow),
        changed: true,
      };
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

    const row = await rpcUpdateAssistantMessage({
      sessionId,
      expectedRevision: current.conversationRevision,
      turnId,
      assistantMessageId: snapshot.id,
      message: snapshot,
      turnCheckpoint: checkpoint,
    });
    if (row) {
      return {
        ok: true,
        session: await sessionFromRow(row as SessionRow),
        changed: true,
      };
    }
  }

  throw new Error(
    `Failed to persist step snapshot after ${MAX_CAS_ATTEMPTS} CAS attempts`,
  );
}

async function terminalSessionTurn(
  current: Session,
  turnId: string,
  assistantMessageId: string,
  message: UIMessage | null,
  checkpoint: number,
  status: Extract<SessionRunStatus, "completed" | "failed" | "cancelled">,
): Promise<Session | null> {
  const row = await rpcTerminalSessionTurn({
    sessionId: current.id,
    expectedRevision: current.conversationRevision,
    turnId,
    assistantMessageId,
    message,
    checkpoint,
    status,
  });
  return row ? sessionFromRow(row as SessionRow) : null;
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

    const message = terminalAssistantMessage(current.messages, snapshot);
    const updated = await terminalSessionTurn(
      current,
      turnId,
      snapshot.id,
      message,
      checkpoint,
      "completed",
    );
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
    const message = assistantHasPersistedContent(assistant)
      ? getTurnAssistant(
          applyAssistantSnapshot(current.messages, assistant),
          current.activeAssistantMessageId,
        )
      : null;
    const updated = await terminalSessionTurn(
      current,
      turnId,
      current.activeAssistantMessageId,
      message,
      current.turnCheckpoint,
      "cancelled",
    );
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
    const message = assistantHasPersistedContent(assistant)
      ? getTurnAssistant(
          applyAssistantSnapshot(current.messages, assistant),
          current.activeAssistantMessageId,
        )
      : null;
    const updated = await terminalSessionTurn(
      current,
      turnId,
      current.activeAssistantMessageId,
      message,
      current.turnCheckpoint,
      "failed",
    );
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
