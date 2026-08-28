import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionRow } from "./store-supabase";

const { memory } = vi.hoisted(() => ({
  memory: new Map<string, SessionRow>(),
}));

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

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => ({
    from(table: string) {
      if (table !== "sessions") {
        throw new Error(`unexpected table ${table}`);
      }
      return createSessionsQuery(memory);
    },
  }),
}));

import {
  attachSessionRunSupabase,
  claimSessionTurnSupabase,
  failSessionTurnSupabase,
  finalizeSessionTurnCancellationSupabase,
  finishSessionTurnSupabase,
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
    schema_version: 3,
    title: "New Project",
    created_at: now,
    updated_at: now,
    messages: [],
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
    expect(memory.get("sess_1")?.messages).toHaveLength(2);
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

    const tool = memory.get("sess_1")!.messages.at(-1)!.parts[1];
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
    expect(memory.get("sess_1")?.messages.at(-1)?.parts[0]).toMatchObject({
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
});
