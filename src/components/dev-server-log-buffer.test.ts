import { describe, expect, it } from "vitest";

import {
  DEV_LOG_BUFFER_LIMIT,
  appendDevLogChunk,
  applyDevLogSnapshot,
  clearDevLogBuffer,
  emptyDevLogBuffer,
  setDevLogIdentity,
} from "./dev-server-log-buffer";

const identity = {
  generation: 2,
  cmdId: "cmd-2",
  sessionName: "preview-sess",
};

describe("dev server log buffer", () => {
  it("resets when the command identity changes", () => {
    let state = setDevLogIdentity(emptyDevLogBuffer(), identity);
    state = appendDevLogChunk(state, "stdout", "old");
    state = setDevLogIdentity(state, { ...identity, cmdId: "cmd-3" });
    expect(state.text).toBe("");
    expect(state.identity?.cmdId).toBe("cmd-3");
  });

  it("labels snapshot streams instead of inventing their order", () => {
    const state = applyDevLogSnapshot(
      setDevLogIdentity(emptyDevLogBuffer(), identity),
      "server ready\n",
      "warning\n",
    );
    expect(state.text).toContain("[stdout]\nserver ready");
    expect(state.text).toContain("[stderr]\nwarning");
  });

  it("removes snapshot overlap from the first followed chunk", () => {
    let state = applyDevLogSnapshot(
      setDevLogIdentity(emptyDevLogBuffer(), identity),
      "abc",
      "",
    );
    state = appendDevLogChunk(state, "stdout", "abcdef");
    expect(state.text).toContain("abcdef");
    expect(state.text).not.toContain("abcabcdef");
  });

  it("keeps clear watermarks across reconnect snapshots", () => {
    let state = applyDevLogSnapshot(
      setDevLogIdentity(emptyDevLogBuffer(), identity),
      "old\n",
      "",
    );
    state = clearDevLogBuffer(state);
    state = applyDevLogSnapshot(state, "old\nnew\n", "");
    expect(state.text).not.toContain("old");
    expect(state.text).toContain("new");
  });

  it("honors clear clicked between meta and the first snapshot", () => {
    let state = setDevLogIdentity(emptyDevLogBuffer(), identity);
    state = clearDevLogBuffer(state);
    state = applyDevLogSnapshot(state, "history\n", "warning\n");
    expect(state.text).toBe("");
    state = appendDevLogChunk(state, "stdout", "new\n");
    expect(state.text).toContain("new");
  });

  it("bounds long-running output", () => {
    let state = setDevLogIdentity(emptyDevLogBuffer(), identity);
    state = appendDevLogChunk(
      state,
      "stdout",
      "x".repeat(DEV_LOG_BUFFER_LIMIT + 100),
    );
    expect(state.truncated).toBe(true);
    expect(state.text).toContain("Earlier logs truncated");
    expect(state.text.length).toBeLessThan(DEV_LOG_BUFFER_LIMIT + 100);
  });
});
