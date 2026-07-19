import { describe, expect, it } from "vitest";

import {
  isActiveRunStatus,
  isLiveChatTurn,
  isTerminalRunStatus,
} from "./types";

describe("isActiveRunStatus", () => {
  it("is true only for pending/running", () => {
    expect(isActiveRunStatus("pending")).toBe(true);
    expect(isActiveRunStatus("running")).toBe(true);
    expect(isActiveRunStatus("idle")).toBe(false);
    expect(isActiveRunStatus("completed")).toBe(false);
    expect(isActiveRunStatus("failed")).toBe(false);
    expect(isActiveRunStatus("cancelled")).toBe(false);
  });
});

describe("isTerminalRunStatus", () => {
  it("is true for completed/failed/cancelled", () => {
    expect(isTerminalRunStatus("completed")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
    expect(isTerminalRunStatus("cancelled")).toBe(true);
    expect(isTerminalRunStatus("idle")).toBe(false);
    expect(isTerminalRunStatus("running")).toBe(false);
  });
});

describe("isLiveChatTurn", () => {
  it("locks while the run is pending or running", () => {
    expect(isLiveChatTurn("ready", "running")).toBe(true);
    expect(isLiveChatTurn("ready", "pending")).toBe(true);
    expect(isLiveChatTurn("streaming", "running")).toBe(true);
  });

  it("locks on submit/stream before the server marks the run active", () => {
    expect(isLiveChatTurn("submitted", "idle")).toBe(true);
    expect(isLiveChatTurn("streaming", "idle")).toBe(true);
  });

  it("unlocks once runStatus is terminal even if transport is still streaming", () => {
    // Post-turn git / workflow drain can keep useChat in "streaming" for seconds
    // after messages are persisted and runStatus flips to completed.
    expect(isLiveChatTurn("streaming", "completed")).toBe(false);
    expect(isLiveChatTurn("streaming", "failed")).toBe(false);
    expect(isLiveChatTurn("submitted", "cancelled")).toBe(false);
  });

  it("stays unlocked when idle and chat is ready", () => {
    expect(isLiveChatTurn("ready", "idle")).toBe(false);
    expect(isLiveChatTurn("ready", "completed")).toBe(false);
  });

  it("cannot alone lock turn-2+ submit while prior runStatus is still terminal", () => {
    // Stale completed from the previous turn — Chat must optimistic-lock until
    // the server projects pending/running (see awaitingRunStart).
    expect(isLiveChatTurn("submitted", "completed")).toBe(false);
    expect(isLiveChatTurn("streaming", "completed")).toBe(false);
  });
});
