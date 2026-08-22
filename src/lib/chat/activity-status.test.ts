import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";

import {
  CHAT_PLANNING_LABEL,
  resolveChatActivityLabel,
} from "./activity-status";

function user(id: string): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text: "build a todo app" }],
  };
}

function assistant(
  id: string,
  parts: UIMessage["parts"],
): UIMessage {
  return { id, role: "assistant", parts };
}

describe("resolveChatActivityLabel", () => {
  it("returns null when the turn is not live", () => {
    expect(
      resolveChatActivityLabel({
        live: false,
        lastMessage: user("u1"),
      }),
    ).toBeNull();
  });

  it("shows planning after send while waiting for the assistant", () => {
    expect(
      resolveChatActivityLabel({
        live: true,
        lastMessage: user("u1"),
      }),
    ).toBe(CHAT_PLANNING_LABEL);

    expect(
      resolveChatActivityLabel({
        live: true,
        lastMessage: undefined,
      }),
    ).toBe(CHAT_PLANNING_LABEL);

    expect(
      resolveChatActivityLabel({
        live: true,
        lastMessage: assistant("a1", []),
      }),
    ).toBe(CHAT_PLANNING_LABEL);
  });

  it("shows planning after tool results while the model plans next steps", () => {
    expect(
      resolveChatActivityLabel({
        live: true,
        lastMessage: assistant("a1", [
          {
            type: "tool-readFile",
            toolCallId: "call_1",
            state: "output-available",
            input: { path: "src/app/page.tsx" },
            output: { content: "…" },
          },
        ]),
      }),
    ).toBe(CHAT_PLANNING_LABEL);

    expect(
      resolveChatActivityLabel({
        live: true,
        lastMessage: assistant("a1", [
          {
            type: "tool-editFile",
            toolCallId: "call_2",
            state: "output-error",
            input: { path: "src/app/page.tsx" },
            errorText: "Interrupted by user",
          },
        ]),
      }),
    ).toBe(CHAT_PLANNING_LABEL);
  });

  it("hides planning while a tool row is already in progress", () => {
    expect(
      resolveChatActivityLabel({
        live: true,
        lastMessage: assistant("a1", [
          {
            type: "tool-writeFile",
            toolCallId: "call_3",
            state: "input-available",
            input: { path: "src/app/page.tsx" },
          },
        ]),
      }),
    ).toBeNull();

    expect(
      resolveChatActivityLabel({
        live: true,
        lastMessage: assistant("a1", [
          {
            type: "tool-checkPreview",
            toolCallId: "call_4",
            state: "input-streaming",
            input: {},
          },
        ]),
      }),
    ).toBeNull();
  });

  it("hides planning while text or reasoning is the latest activity", () => {
    expect(
      resolveChatActivityLabel({
        live: true,
        lastMessage: assistant("a1", [
          { type: "text", text: "Working on it", state: "streaming" },
        ]),
      }),
    ).toBeNull();

    expect(
      resolveChatActivityLabel({
        live: true,
        lastMessage: assistant("a1", [
          { type: "reasoning", text: "…", state: "streaming" },
        ]),
      }),
    ).toBeNull();

    expect(
      resolveChatActivityLabel({
        live: true,
        lastMessage: assistant("a1", [
          { type: "text", text: "Done.", state: "done" },
        ]),
      }),
    ).toBeNull();
  });
});
