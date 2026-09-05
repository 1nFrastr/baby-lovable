import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionRow } from "./store-supabase";

interface MessageRow {
  session_id: string;
  message_id: string;
  position: number;
  role: string;
  message: UIMessage;
  created_at: string;
  updated_at: string;
}

const { memory, messageMemory } = vi.hoisted(() => ({
  memory: new Map<string, SessionRow>(),
  messageMemory: new Map<string, MessageRow[]>(),
}));

function sortedMessages(sessionId: string): MessageRow[] {
  return [...(messageMemory.get(sessionId) ?? [])].sort(
    (left, right) => left.position - right.position,
  );
}

function loadMessages(sessionId: string): UIMessage[] {
  return sortedMessages(sessionId).map((row) => structuredClone(row.message));
}

function upsertMessage(
  sessionId: string,
  position: number,
  message: UIMessage,
) {
  const rows = messageMemory.get(sessionId) ?? [];
  const existingIndex = rows.findIndex(
    (row) => row.message_id === message.id,
  );
  const next: MessageRow = {
    session_id: sessionId,
    message_id: message.id,
    position,
    role: message.role,
    message: structuredClone(message),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (existingIndex >= 0) {
    rows[existingIndex] = next;
  } else {
    rows.push(next);
  }
  messageMemory.set(sessionId, rows);
}

function replaceAllMessages(sessionId: string, messages: UIMessage[]) {
  messageMemory.set(
    sessionId,
    messages.map((message, position) => ({
      session_id: sessionId,
      message_id: message.id,
      position,
      role: message.role,
      message: structuredClone(message),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })),
  );
  const row = memory.get(sessionId);
  if (row) {
    row.message_count = messages.length;
  }
}

function deleteMessage(sessionId: string, messageId: string) {
  const rows = (messageMemory.get(sessionId) ?? []).filter(
    (row) => row.message_id !== messageId,
  );
  messageMemory.set(sessionId, rows);
  const row = memory.get(sessionId);
  if (row) {
    row.message_count = rows.length;
  }
}

function createSessionsQuery(rows: Map<string, SessionRow>) {
  const filters: Array<(row: SessionRow) => boolean> = [];
  let patch: Record<string, unknown> | null = null;

  const query = {
    select() {
      return query;
    },
    update(next: Record<string, unknown>) {
      patch = next;
      return query;
    },
    eq(column: string, value: unknown) {
      filters.push(
        (row) => (row as unknown as Record<string, unknown>)[column] === value,
      );
      return query;
    },
    is(column: string, value: unknown) {
      filters.push(
        (row) => (row as unknown as Record<string, unknown>)[column] == value,
      );
      return query;
    },
    async maybeSingle() {
      const matches = [...rows.values()].filter((row) =>
        filters.every((match) => match(row)),
      );
      const current = matches[0];
      if (!patch) {
        return {
          data: current ? structuredClone(current) : null,
          error: null,
        };
      }
      if (!current) {
        return { data: null, error: null };
      }
      const next = {
        ...current,
        ...patch,
      } as SessionRow;
      rows.set(current.id, next);
      return { data: structuredClone(next), error: null };
    },
  };

  return query;
}

function createSessionMessagesQuery(sessionIdFilter?: string) {
  const filters: Array<(row: MessageRow) => boolean> = [];
  if (sessionIdFilter) {
    filters.push((row) => row.session_id === sessionIdFilter);
  }

  const query = {
    select() {
      return query;
    },
    eq(column: string, value: unknown) {
      filters.push(
        (row) => (row as unknown as Record<string, unknown>)[column] === value,
      );
      return query;
    },
    order(column: string, options: { ascending: boolean }) {
      void column;
      void options;
      return query;
    },
    async maybeSingle() {
      const matches = [...messageMemory.values()]
        .flat()
        .filter((row) => filters.every((match) => match(row)));
      return {
        data: matches[0] ? structuredClone(matches[0]) : null,
        error: null,
      };
    },
    then(
      resolve: (value: { data: MessageRow[] | null; error: null }) => void,
    ) {
      const matches = [...messageMemory.values()]
        .flat()
        .filter((row) => filters.every((match) => match(row)))
        .sort((left, right) => left.position - right.position);
      resolve({ data: matches.map((row) => structuredClone(row)), error: null });
    },
  };

  return query;
}

function handleRpc(
  fn: string,
  params: Record<string, unknown>,
): SessionRow[] | null {
  const sessionId = String(params.p_session_id);
  const current = memory.get(sessionId);
  if (!current) {
    return null;
  }

  if (fn === "cas_claim_session_turn") {
    if (
      current.conversation_revision !== params.p_expected_revision ||
      current.active_turn_id != null ||
      ["pending", "running", "cancelling"].includes(current.run_status)
    ) {
      return null;
    }
    const userMessage = params.p_user_message as UIMessage;
    const assistantMessage = params.p_assistant_message as UIMessage;
    const nextPosition = sortedMessages(sessionId).length;
    upsertMessage(sessionId, nextPosition, userMessage);
    upsertMessage(sessionId, nextPosition + 1, assistantMessage);
    const next: SessionRow = {
      ...current,
      title: String(params.p_title),
      run_status: "pending",
      last_run_id: null,
      active_turn_id: String(params.p_turn_id),
      active_assistant_message_id: String(params.p_assistant_message_id),
      active_turn_started_at: String(params.p_started_at),
      turn_checkpoint: -1,
      conversation_revision: current.conversation_revision + 1,
      message_count: nextPosition + 2,
      updated_at: new Date().toISOString(),
    };
    memory.set(sessionId, next);
    return [structuredClone(next)];
  }

  if (fn === "cas_update_assistant_message") {
    if (
      current.conversation_revision !== params.p_expected_revision ||
      current.active_turn_id !== params.p_expected_turn_id ||
      current.active_assistant_message_id !== params.p_assistant_message_id ||
      !["pending", "running", "cancelling"].includes(current.run_status)
    ) {
      return null;
    }
    const message = params.p_message as UIMessage;
    upsertMessage(
      sessionId,
      sortedMessages(sessionId).find(
        (row) => row.message_id === message.id,
      )?.position ?? sortedMessages(sessionId).length,
      message,
    );
    const next: SessionRow = {
      ...current,
      conversation_revision: current.conversation_revision + 1,
      turn_checkpoint:
        params.p_turn_checkpoint == null
          ? current.turn_checkpoint
          : Number(params.p_turn_checkpoint),
      updated_at: new Date().toISOString(),
    };
    memory.set(sessionId, next);
    return [structuredClone(next)];
  }

  if (fn === "cas_terminal_session_turn") {
    if (
      current.conversation_revision !== params.p_expected_revision ||
      current.active_turn_id !== params.p_expected_turn_id ||
      current.active_assistant_message_id !== params.p_assistant_message_id
    ) {
      return null;
    }
    const assistantMessageId = String(params.p_assistant_message_id);
    if (params.p_message == null) {
      deleteMessage(sessionId, assistantMessageId);
    } else {
      upsertMessage(
        sessionId,
        sortedMessages(sessionId).find(
          (row) => row.message_id === assistantMessageId,
        )?.position ?? sortedMessages(sessionId).length,
        params.p_message as UIMessage,
      );
    }
    const next: SessionRow = {
      ...current,
      run_status: params.p_status as SessionRow["run_status"],
      last_run_id: null,
      active_turn_id: null,
      active_assistant_message_id: null,
      active_turn_started_at: null,
      turn_checkpoint: Number(params.p_checkpoint),
      conversation_revision: current.conversation_revision + 1,
      message_count: sortedMessages(sessionId).length,
      updated_at: new Date().toISOString(),
    };
    memory.set(sessionId, next);
    return [structuredClone(next)];
  }

  if (fn === "cas_replace_session_messages") {
    if (current.conversation_revision !== params.p_expected_revision) {
      return null;
    }
    const messages = (params.p_messages as UIMessage[]) ?? [];
    replaceAllMessages(sessionId, messages);
    const next: SessionRow = {
      ...current,
      conversation_revision: current.conversation_revision + 1,
      message_count: messages.length,
      updated_at: new Date().toISOString(),
    };
    memory.set(sessionId, next);
    return [structuredClone(next)];
  }

  if (fn === "cas_insert_compaction_messages") {
    if (
      current.conversation_revision !== params.p_expected_revision ||
      current.active_turn_id !== params.p_expected_turn_id ||
      !["pending", "running"].includes(current.run_status)
    ) {
      return null;
    }
    const nail = params.p_nail as UIMessage;
    const summary = params.p_summary as UIMessage;
    const existing = sortedMessages(sessionId);
    if (
      existing.some((row) => row.message_id === nail.id) &&
      existing.some((row) => row.message_id === summary.id)
    ) {
      return [structuredClone(current)];
    }
    const beforeId = String(params.p_before_message_id);
    const insertAt = existing.findIndex((row) => row.message_id === beforeId);
    if (insertAt < 0) {
      throw new Error(`before message ${beforeId} not found`);
    }
    const nextMessages = existing.map((row) => row.message);
    nextMessages.splice(insertAt, 0, nail, summary);
    replaceAllMessages(sessionId, nextMessages);
    const next: SessionRow = {
      ...current,
      conversation_revision: current.conversation_revision + 1,
      message_count: nextMessages.length,
      updated_at: new Date().toISOString(),
    };
    memory.set(sessionId, next);
    return [structuredClone(next)];
  }

  throw new Error(`unexpected rpc ${fn}`);
}

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => ({
    from(table: string) {
      if (table === "sessions") {
        return createSessionsQuery(memory);
      }
      if (table === "session_messages") {
        return createSessionMessagesQuery();
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc(fn: string, params: Record<string, unknown>) {
      return Promise.resolve({ data: handleRpc(fn, params), error: null });
    },
  }),
}));

import {
  attachSessionRunSupabase,
  claimSessionTurnSupabase,
  failSessionTurnSupabase,
  finalizeSessionTurnCancellationSupabase,
  finishSessionTurnSupabase,
  persistSessionCompactionSupabase,
  persistSessionStepSnapshotSupabase,
  persistSessionToolProgressSupabase,
} from "./turn-store-supabase";

const auth = { userId: "user_1" };

const userMessage: UIMessage = {
  id: "user-1",
  role: "user",
  parts: [{ type: "text", text: "Build a todo app" }],
};

const listCall = {
  toolCallId: "call-list",
  toolName: "listFiles",
  input: { path: "." },
};

function seedIdleSession() {
  const now = "2026-08-28T00:00:00.000Z";
  memory.set("sess_1", {
    id: "sess_1",
    user_id: "user_1",
    schema_version: 4,
    title: "New Project",
    created_at: now,
    updated_at: now,
    message_count: 0,
    last_run_id: null,
    run_status: "idle",
    active_turn_id: null,
    active_assistant_message_id: null,
    conversation_revision: 0,
    turn_checkpoint: -1,
    active_turn_started_at: null,
    sandbox_mode: "daytona",
    deleted_at: null,
  });
  messageMemory.set("sess_1", []);
}

async function claimTurn(turnId = "turn_1", assistantId = "assistant-1") {
  const result = await claimSessionTurnSupabase(
    {
      sessionId: "sess_1",
      turnId,
      assistantMessageId: assistantId,
      userMessage,
    },
    auth,
  );
  expect(result.ok).toBe(true);
  return result;
}

describe("session turn store CAS", () => {
  beforeEach(() => {
    memory.clear();
    messageMemory.clear();
    seedIdleSession();
  });

  it("claims a turn with a stable assistant placeholder and refuses a second claim", async () => {
    const first = await claimTurn();
    expect(first.ok && first.session.activeTurnId).toBe("turn_1");
    expect(first.ok && first.session.activeAssistantMessageId).toBe(
      "assistant-1",
    );
    expect(first.ok && first.session.messages.map((message) => message.id)).toEqual(
      ["user-1", "assistant-1"],
    );

    const second = await claimSessionTurnSupabase(
      {
        sessionId: "sess_1",
        turnId: "turn_2",
        assistantMessageId: "assistant-2",
        userMessage: { ...userMessage, id: "user-2" },
      },
      auth,
    );
    expect(second).toMatchObject({
      ok: false,
      reason: "active_turn",
    });
    expect(memory.get("sess_1")?.active_turn_id).toBe("turn_1");
    expect(loadMessages("sess_1")).toHaveLength(2);
  });

  it("rejects a duplicate user message id", async () => {
    await claimTurn();
    await finishSessionTurnSupabase(
      "sess_1",
      "turn_1",
      0,
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Done", state: "done" }],
      },
    );

    const duplicate = await claimSessionTurnSupabase(
      {
        sessionId: "sess_1",
        turnId: "turn_2",
        assistantMessageId: "assistant-2",
        userMessage,
      },
      auth,
    );
    expect(duplicate).toMatchObject({
      ok: false,
      reason: "duplicate_user_message",
    });
  });

  it("persists tool completion and ignores a later start replay", async () => {
    await claimTurn();
    await attachSessionRunSupabase("sess_1", "turn_1", "wrun_1", auth);

    const started = await persistSessionToolProgressSupabase(
      "sess_1",
      "turn_1",
      "assistant-1",
      { calls: [listCall] },
    );
    expect(started.ok && started.changed).toBe(true);

    const completed = await persistSessionToolProgressSupabase(
      "sess_1",
      "turn_1",
      "assistant-1",
      {
        calls: [listCall],
        completedCallId: "call-list",
        completion: { success: true, output: { files: [] } },
      },
    );
    expect(completed.ok && completed.changed).toBe(true);

    const revision = memory.get("sess_1")!.conversation_revision;
    const replayed = await persistSessionToolProgressSupabase(
      "sess_1",
      "turn_1",
      "assistant-1",
      { calls: [listCall] },
    );
    expect(replayed).toMatchObject({ ok: true, changed: false });
    expect(memory.get("sess_1")?.conversation_revision).toBe(revision);

    const tool = loadMessages("sess_1").at(-1)!.parts[1];
    expect(tool).toMatchObject({
      toolCallId: "call-list",
      state: "output-available",
    });
  });

  it("fences stale turn writers after a newer turn owns the session", async () => {
    await claimTurn("turn_old", "assistant-old");
    await persistSessionToolProgressSupabase(
      "sess_1",
      "turn_old",
      "assistant-old",
      { calls: [listCall] },
    );
    await finishSessionTurnSupabase("sess_1", "turn_old", 0, {
      id: "assistant-old",
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "tool-listFiles",
          toolCallId: "call-list",
          state: "output-available",
          input: { path: "." },
          output: { files: [] },
        },
      ],
    });

    await claimSessionTurnSupabase(
      {
        sessionId: "sess_1",
        turnId: "turn_new",
        assistantMessageId: "assistant-new",
        userMessage: { ...userMessage, id: "user-2" },
      },
      auth,
    );

    const stale = await persistSessionToolProgressSupabase(
      "sess_1",
      "turn_old",
      "assistant-old",
      {
        calls: [listCall],
        completedCallId: "call-list",
        completion: { success: true, output: { files: ["stale"] } },
      },
    );
    expect(stale).toMatchObject({ ok: false, reason: "stale_turn" });
    expect(memory.get("sess_1")?.active_turn_id).toBe("turn_new");
  });

  it("skips an older step checkpoint and keeps the richer snapshot", async () => {
    await claimTurn();
    const first = await persistSessionStepSnapshotSupabase(
      "sess_1",
      "turn_1",
      1,
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "step 1", state: "done" }],
      },
    );
    expect(first.ok && first.changed).toBe(true);

    const older = await persistSessionStepSnapshotSupabase(
      "sess_1",
      "turn_1",
      0,
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "stale", state: "done" }],
      },
    );
    expect(older).toMatchObject({ ok: true, changed: false });
    expect(loadMessages("sess_1").at(-1)?.parts[0]).toMatchObject({
      text: "step 1",
    });
  });

  it("finishes the turn by clearing the lease without duplicating the assistant", async () => {
    await claimTurn();
    const finished = await finishSessionTurnSupabase("sess_1", "turn_1", 2, {
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "text", text: "All set", state: "done" }],
    });
    expect(finished.ok).toBe(true);
    if (!finished.ok) {
      return;
    }
    expect(finished.session.runStatus).toBe("completed");
    expect(finished.session.activeTurnId).toBeUndefined();
    expect(finished.session.activeAssistantMessageId).toBeUndefined();
    expect(finished.session.lastRunId).toBeUndefined();
    expect(finished.ok && finished.session.messages.map((m) => m.id)).toEqual([
      "user-1",
      "assistant-1",
    ]);
  });

  it("keeps completed tools and interrupts the running tool on cancel", async () => {
    await claimTurn();
    await persistSessionToolProgressSupabase(
      "sess_1",
      "turn_1",
      "assistant-1",
      {
        calls: [
          listCall,
          {
            toolCallId: "call-write",
            toolName: "writeFile",
            input: { path: "src/app/page.tsx" },
          },
        ],
        completedCallId: "call-list",
        completion: { success: true, output: { files: [] } },
      },
    );

    const cancelled = await finalizeSessionTurnCancellationSupabase(
      "sess_1",
      "turn_1",
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          {
            type: "tool-listFiles",
            toolCallId: "call-list",
            state: "input-available",
            input: { path: "." },
          },
          {
            type: "tool-writeFile",
            toolCallId: "call-write",
            state: "input-available",
            input: { path: "src/app/page.tsx" },
          },
        ],
      },
      auth,
    );

    expect(cancelled.ok && cancelled.session.runStatus).toBe("cancelled");
    const assistant = cancelled.ok
      ? cancelled.session.messages.at(-1)
      : undefined;
    expect(assistant?.parts[1]).toMatchObject({
      toolCallId: "call-list",
      state: "output-available",
    });
    expect(assistant?.parts[2]).toMatchObject({
      toolCallId: "call-write",
      state: "output-error",
      errorText: "Interrupted by user",
    });
    expect(cancelled.ok && cancelled.session.activeTurnId).toBeUndefined();
  });

  it("fails a turn without unlocking a different active turn", async () => {
    await claimTurn("turn_1");
    const failed = await failSessionTurnSupabase("sess_1", "turn_other");
    expect(failed).toMatchObject({ ok: false, reason: "stale_turn" });
    expect(memory.get("sess_1")?.run_status).toBe("pending");
    expect(memory.get("sess_1")?.active_turn_id).toBe("turn_1");
  });

  it("inserts compaction nail and summary before the current user", async () => {
    await claimTurn();
    const nail: UIMessage = {
      id: "cmp_turn_1",
      role: "user",
      parts: [
        {
          type: "data-compaction",
          data: { auto: true, tailStartId: "user-1" },
        },
      ],
    };
    const summary: UIMessage = {
      id: "csm_turn_1",
      role: "assistant",
      metadata: { summary: true },
      parts: [{ type: "text", text: "## Goal\n- Build a todo app" }],
    };
    const result = await persistSessionCompactionSupabase(
      "sess_1",
      "turn_1",
      "user-1",
      nail,
      summary,
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.session.messages.map((message) => message.id)).toEqual(
      ["cmp_turn_1", "csm_turn_1", "user-1", "assistant-1"],
    );

    const again = await persistSessionCompactionSupabase(
      "sess_1",
      "turn_1",
      "user-1",
      nail,
      summary,
    );
    expect(again.ok && again.changed).toBe(false);
  });
});
