import { describe, expect, it } from "vitest";

import {
  isComposerLocked,
  shouldReleaseComposerAfterStop,
} from "./composer-lock";

describe("isComposerLocked", () => {
  it("locks for the whole cancel round-trip even if chat already looks idle", () => {
    expect(
      isComposerLocked({
        stopping: true,
        awaitingRunStart: false,
        chatStatus: "ready",
        runStatus: "running",
      }),
    ).toBe(true);
    expect(
      isComposerLocked({
        stopping: true,
        awaitingRunStart: false,
        chatStatus: "ready",
        runStatus: "cancelled",
      }),
    ).toBe(true);
  });

  it("locks during optimistic send before the server marks the run active", () => {
    expect(
      isComposerLocked({
        stopping: false,
        awaitingRunStart: true,
        chatStatus: "ready",
        runStatus: "completed",
      }),
    ).toBe(true);
  });

  it("unlocks only when idle and not stopping", () => {
    expect(
      isComposerLocked({
        stopping: false,
        awaitingRunStart: false,
        chatStatus: "ready",
        runStatus: "cancelled",
      }),
    ).toBe(false);
    expect(
      isComposerLocked({
        stopping: false,
        awaitingRunStart: false,
        chatStatus: "streaming",
        runStatus: "cancelled",
      }),
    ).toBe(false);
  });
});

describe("shouldReleaseComposerAfterStop", () => {
  it("does not unlock on cancel HTTP success while the run is still active", () => {
    expect(
      shouldReleaseComposerAfterStop({
        cancelSucceeded: true,
        runStatus: "running",
        observedActiveRun: true,
      }),
    ).toBe(false);
    expect(
      shouldReleaseComposerAfterStop({
        cancelSucceeded: true,
        runStatus: "pending",
        observedActiveRun: false,
      }),
    ).toBe(false);
  });

  it("does not unlock if cancel has not succeeded yet", () => {
    expect(
      shouldReleaseComposerAfterStop({
        cancelSucceeded: false,
        runStatus: "cancelled",
        observedActiveRun: true,
      }),
    ).toBe(false);
  });

  it("unlocks once session/runtime reports cancelled", () => {
    expect(
      shouldReleaseComposerAfterStop({
        cancelSucceeded: true,
        runStatus: "cancelled",
        observedActiveRun: false,
      }),
    ).toBe(true);
  });

  it("unlocks if the live turn finished on its own while stop was in flight", () => {
    expect(
      shouldReleaseComposerAfterStop({
        cancelSucceeded: true,
        runStatus: "completed",
        observedActiveRun: true,
      }),
    ).toBe(true);
    expect(
      shouldReleaseComposerAfterStop({
        cancelSucceeded: true,
        runStatus: "failed",
        observedActiveRun: true,
      }),
    ).toBe(true);
  });

  it("does not treat a stale previous-turn completed as cancel success", () => {
    expect(
      shouldReleaseComposerAfterStop({
        cancelSucceeded: true,
        runStatus: "completed",
        observedActiveRun: false,
      }),
    ).toBe(false);
  });
});
