import { describe, expect, it } from "vitest";

import {
  isComposerLocked,
  shouldReleaseComposerAfterStop,
  shouldShowStopControl,
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

  it("unlocks when the chat transport is ready even if projection still says running", () => {
    // Auto-finish: HTTP closed ⇒ workflow returned; do not wait on Realtime.
    expect(
      isComposerLocked({
        stopping: false,
        awaitingRunStart: false,
        chatStatus: "ready",
        runStatus: "running",
        resumeActiveRun: false,
      }),
    ).toBe(false);
  });

  it("locks after mid-run refresh while the server run is still active", () => {
    // Transport remounts as ready; SSE is gone but the workflow continues.
    expect(
      isComposerLocked({
        stopping: false,
        awaitingRunStart: false,
        chatStatus: "ready",
        runStatus: "running",
        resumeActiveRun: true,
      }),
    ).toBe(true);
  });

  it("unlocks on terminal runStatus while the HTTP stream is still draining", () => {
    expect(
      isComposerLocked({
        stopping: false,
        awaitingRunStart: false,
        chatStatus: "streaming",
        runStatus: "cancelled",
      }),
    ).toBe(false);
    expect(
      isComposerLocked({
        stopping: false,
        awaitingRunStart: false,
        chatStatus: "streaming",
        runStatus: "completed",
      }),
    ).toBe(false);
  });
});

describe("shouldShowStopControl", () => {
  it("shows stop only while generating and the server has not finished", () => {
    expect(
      shouldShowStopControl({
        stopping: false,
        chatStatus: "streaming",
        runStatus: "running",
      }),
    ).toBe(true);
    expect(
      shouldShowStopControl({
        stopping: false,
        chatStatus: "submitted",
        runStatus: "idle",
      }),
    ).toBe(true);
  });

  it("hides stop after terminal runStatus (HTTP may still drain)", () => {
    expect(
      shouldShowStopControl({
        stopping: false,
        chatStatus: "streaming",
        runStatus: "completed",
      }),
    ).toBe(false);
  });

  it("hides stop while cancel is in flight (stopping UI owns the button)", () => {
    expect(
      shouldShowStopControl({
        stopping: true,
        chatStatus: "streaming",
        runStatus: "running",
      }),
    ).toBe(false);
  });

  it("hides stop during awaiting-send when chat is not busy yet", () => {
    expect(
      shouldShowStopControl({
        stopping: false,
        chatStatus: "ready",
        runStatus: "completed",
      }),
    ).toBe(false);
  });

  it("shows stop after mid-run refresh while the server run is still active", () => {
    expect(
      shouldShowStopControl({
        stopping: false,
        chatStatus: "ready",
        runStatus: "running",
        resumeActiveRun: true,
      }),
    ).toBe(true);
  });

  it("hides stop on ready+running when this is auto-finish not a refresh resume", () => {
    expect(
      shouldShowStopControl({
        stopping: false,
        chatStatus: "ready",
        runStatus: "running",
        resumeActiveRun: false,
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
