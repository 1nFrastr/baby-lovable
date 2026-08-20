import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";

import type { Session } from "@/lib/session/types";

const getSession = vi.fn();
const replaceMessages = vi.fn();
const updateSession = vi.fn();
const readDraft = vi.fn();
const deleteDraft = vi.fn();
const checkpointSessionTurn = vi.fn();
const getRun = vi.fn();

vi.mock("@/lib/session/store", () => ({
  getSession: (...args: unknown[]) => getSession(...args),
  replaceMessages: (...args: unknown[]) => replaceMessages(...args),
  updateSession: (...args: unknown[]) => updateSession(...args),
}));

vi.mock("@/lib/session/draft-store", () => ({
  readDraft: (...args: unknown[]) => readDraft(...args),
  deleteDraft: (...args: unknown[]) => deleteDraft(...args),
}));

vi.mock("@/lib/git/checkpoint-session-turn", () => ({
  checkpointSessionTurn: (...args: unknown[]) => checkpointSessionTurn(...args),
}));

vi.mock("workflow/api", () => ({
  getRun: (...args: unknown[]) => getRun(...args),
}));

function session(overrides: Partial<Session> = {}): Session {
  return {
    schemaVersion: 2,
    id: "sess_1",
    userId: "user_1",
    title: "Todo app",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages: [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "build a todo app" }],
      },
    ],
    lastRunId: "wrun_1",
    runStatus: "running",
    sandboxMode: "daytona",
    ...overrides,
  };
}

describe("cancelSessionRun", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    checkpointSessionTurn.mockResolvedValue({ ran: true });
    deleteDraft.mockResolvedValue(undefined);
    getRun.mockResolvedValue({
      cancel: vi.fn().mockResolvedValue(undefined),
    });
    replaceMessages.mockImplementation(
      async (_id: string, messages: UIMessage[]) =>
        session({ messages, runStatus: "running" }),
    );
    updateSession.mockImplementation(async (_id: string, input: object) =>
      session({ ...input, lastRunId: undefined, runStatus: "cancelled" }),
    );
  });

  it("persists a finalized draft and cancels the workflow run", async () => {
    getSession.mockResolvedValue(session());
    readDraft.mockResolvedValue({
      runId: "wrun_1",
      updatedAt: "2026-01-01T00:00:01.000Z",
      message: {
        id: "a-draft",
        role: "assistant",
        parts: [
          {
            type: "tool-writeFile",
            toolCallId: "call_1",
            state: "input-available",
            input: { path: "src/app/page.tsx" },
          },
        ],
      },
    });

    const { cancelSessionRun } = await import("./cancel-session-run");
    const result = await cancelSessionRun("sess_1", { userId: "user_1" });

    expect(result).toMatchObject({
      ok: true,
      runStatus: "cancelled",
      cancelledRunId: "wrun_1",
      persistedAssistant: true,
    });
    expect(replaceMessages).toHaveBeenCalledOnce();
    const persisted = replaceMessages.mock.calls[0]?.[1] as UIMessage[];
    expect(persisted.at(-1)?.parts[0]).toMatchObject({
      state: "output-error",
      errorText: "Interrupted by user",
    });
    expect(updateSession).toHaveBeenCalledWith(
      "sess_1",
      { runStatus: "cancelled", lastRunId: null },
      { userId: "user_1" },
    );
    expect(checkpointSessionTurn).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "cancelled", runId: "wrun_1" }),
    );
    expect(getRun).toHaveBeenCalledWith("wrun_1");
  });

  it("marks cancelled without a run id so in-flight POST /chat can discard", async () => {
    getSession.mockResolvedValue(
      session({ lastRunId: undefined, runStatus: "pending" }),
    );

    const { cancelSessionRun } = await import("./cancel-session-run");
    const result = await cancelSessionRun("sess_1", { userId: "user_1" });

    expect(result).toMatchObject({
      ok: true,
      runStatus: "cancelled",
      cancelledRunId: null,
      persistedAssistant: false,
    });
    expect(replaceMessages).not.toHaveBeenCalled();
    expect(updateSession).toHaveBeenCalledWith(
      "sess_1",
      { runStatus: "cancelled", lastRunId: null },
      { userId: "user_1" },
    );
    expect(getRun).not.toHaveBeenCalled();
  });

  it("is a no-op persist when already cancelled", async () => {
    getSession.mockResolvedValue(
      session({ lastRunId: undefined, runStatus: "cancelled" }),
    );

    const { cancelSessionRun } = await import("./cancel-session-run");
    const result = await cancelSessionRun("sess_1", { userId: "user_1" });

    expect(result).toMatchObject({ ok: true, runStatus: "cancelled" });
    expect(updateSession).not.toHaveBeenCalled();
    expect(replaceMessages).not.toHaveBeenCalled();
  });

  it("returns 404 when the session is missing", async () => {
    getSession.mockResolvedValue(null);
    const { cancelSessionRun } = await import("./cancel-session-run");
    const result = await cancelSessionRun("sess_missing", { userId: "user_1" });
    expect(result).toEqual({
      ok: false,
      error: "Session not found",
      status: 404,
    });
  });
});
