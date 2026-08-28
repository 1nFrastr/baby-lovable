import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "@/lib/session/types";

const getSession = vi.fn();
const replaceMessages = vi.fn();
const updateSession = vi.fn();
const beginSessionTurnCancellation = vi.fn();
const finalizeSessionTurnCancellation = vi.fn();
const checkpointSessionTurn = vi.fn();
const cancelWorkflow = vi.fn();
const getRun = vi.fn();

vi.mock("@/lib/session/store", () => ({
  getSession: (...args: unknown[]) => getSession(...args),
  replaceMessages: (...args: unknown[]) => replaceMessages(...args),
  updateSession: (...args: unknown[]) => updateSession(...args),
}));

vi.mock("@/lib/session/turn-store", () => ({
  beginSessionTurnCancellation: (...args: unknown[]) =>
    beginSessionTurnCancellation(...args),
  finalizeSessionTurnCancellation: (...args: unknown[]) =>
    finalizeSessionTurnCancellation(...args),
}));

vi.mock("@/lib/git/checkpoint-session-turn", () => ({
  checkpointSessionTurn: (...args: unknown[]) =>
    checkpointSessionTurn(...args),
}));

vi.mock("workflow/api", () => ({
  getRun: (...args: unknown[]) => getRun(...args),
}));

function session(overrides: Partial<Session> = {}): Session {
  return {
    schemaVersion: 3,
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
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "Working" }],
      },
    ],
    lastRunId: "wrun_1",
    runStatus: "running",
    activeTurnId: "turn_1",
    activeAssistantMessageId: "a1",
    activeTurnStartedAt: "2026-01-01T00:00:00.000Z",
    conversationRevision: 2,
    turnCheckpoint: 0,
    sandboxMode: "daytona",
    ...overrides,
  };
}

describe("cancelSessionRun", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    cancelWorkflow.mockResolvedValue(undefined);
    getRun.mockResolvedValue({
      cancel: cancelWorkflow,
      status: Promise.resolve("cancelled"),
    });
    checkpointSessionTurn.mockResolvedValue({ ran: true });
    beginSessionTurnCancellation.mockResolvedValue({
      ok: true,
      changed: true,
      session: session({ runStatus: "cancelling" }),
    });
    finalizeSessionTurnCancellation.mockResolvedValue({
      ok: true,
      changed: true,
      session: session({
        runStatus: "cancelled",
        lastRunId: undefined,
        activeTurnId: undefined,
        activeAssistantMessageId: undefined,
      }),
    });
  });

  it("cancels the matching workflow before sealing the turn", async () => {
    getSession.mockResolvedValue(session());
    const { cancelSessionRun } = await import("./cancel-session-run");

    const result = await cancelSessionRun(
      "sess_1",
      { userId: "user_1" },
      { expectedTurnId: "turn_1" },
    );

    expect(result).toMatchObject({
      ok: true,
      runStatus: "cancelled",
      cancelledRunId: "wrun_1",
    });
    expect(cancelWorkflow).toHaveBeenCalledOnce();
    expect(
      cancelWorkflow.mock.invocationCallOrder[0],
    ).toBeLessThan(
      finalizeSessionTurnCancellation.mock.invocationCallOrder[0]!,
    );
    expect(checkpointSessionTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "cancelled",
        runId: "wrun_1",
      }),
    );
  });

  it("keeps the turn cancelling when workflow cancellation fails", async () => {
    getSession.mockResolvedValue(session());
    cancelWorkflow.mockRejectedValue(new Error("runtime unavailable"));
    getRun
      .mockResolvedValueOnce({
        cancel: cancelWorkflow,
        status: Promise.resolve("running"),
      })
      .mockResolvedValueOnce({
        cancel: cancelWorkflow,
        status: Promise.resolve("running"),
      });
    const { cancelSessionRun } = await import("./cancel-session-run");

    const result = await cancelSessionRun("sess_1", {
      userId: "user_1",
    });

    expect(result).toEqual({
      ok: false,
      error: "runtime unavailable",
      status: 503,
    });
    expect(finalizeSessionTurnCancellation).not.toHaveBeenCalled();
  });

  it("rejects a stale expected turn token", async () => {
    getSession.mockResolvedValue(session());
    const { cancelSessionRun } = await import("./cancel-session-run");

    const result = await cancelSessionRun(
      "sess_1",
      { userId: "user_1" },
      { expectedTurnId: "turn_old" },
    );

    expect(result).toEqual({
      ok: false,
      error: "The active turn changed before cancellation",
      status: 409,
    });
    expect(beginSessionTurnCancellation).not.toHaveBeenCalled();
  });

  it("is idempotent after the turn is already cancelled", async () => {
    getSession.mockResolvedValue(
      session({
        runStatus: "cancelled",
        lastRunId: undefined,
        activeTurnId: undefined,
        activeAssistantMessageId: undefined,
      }),
    );
    const { cancelSessionRun } = await import("./cancel-session-run");

    const result = await cancelSessionRun("sess_1", {
      userId: "user_1",
    });

    expect(result).toMatchObject({
      ok: true,
      runStatus: "cancelled",
      cancelledRunId: null,
    });
    expect(getRun).not.toHaveBeenCalled();
  });
});
