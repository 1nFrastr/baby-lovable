import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import { mergeDisplayMessages } from "./merge-messages";

function user(id: string, text: string): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
  };
}

function assistant(id: string, text: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
  };
}

describe("mergeDisplayMessages", () => {
  it("does not append a stale previous-turn draft after a new user send", () => {
    const persisted = [user("u1", "hi"), assistant("a1", "hello")];
    const chatMessages = [...persisted, user("u2", "again")];
    const staleDraft = assistant("a-draft", "hello from last turn");

    const merged = mergeDisplayMessages(
      persisted,
      chatMessages,
      staleDraft,
      true,
      false,
      false,
    );

    expect(merged.map((message) => message.id)).toEqual(["u1", "a1", "u2"]);
  });

  it("overlays draft after the user message while the run is active", () => {
    const persisted = [user("u1", "hi")];
    const chatMessages = persisted;
    const draft = assistant("a-draft", "streaming…");

    const merged = mergeDisplayMessages(
      persisted,
      chatMessages,
      draft,
      true,
      false,
      true,
    );

    expect(merged.map((message) => message.id)).toEqual(["u1", "a-draft"]);
    expect(merged.at(-1)?.parts).toEqual(draft.parts);
  });

  it("keeps the live assistant when persisted is missing the final summary text", () => {
    const chatAssistant = assistant(
      "a-sse",
      "Preview passed checkPreview; the app is ready to use.",
    );
    const persistedAssistant = assistant("a-draft", "");
    persistedAssistant.parts = [
      {
        type: "tool-checkPreview",
        toolCallId: "call_1",
        state: "output-available",
        input: {},
        output: { ok: true },
      },
    ];

    const persisted = [user("u1", "Build a todo app"), persistedAssistant];
    const chatMessages = [user("u1", "Build a todo app"), chatAssistant];

    const merged = mergeDisplayMessages(
      persisted,
      chatMessages,
      null,
      false,
      false,
      false,
    );

    const last = merged.at(-1);
    expect(last?.id).toBe("a-sse");
    expect(
      last?.parts.some(
        (part) =>
          part.type === "text" &&
          part.text.includes("the app is ready to use"),
      ),
    ).toBe(true);
  });

  it("does not re-append a draft whose id is already in the thread", () => {
    const staleDraft = assistant("a1", "hello from last turn");
    const persisted = [user("u1", "hi"), assistant("a1", "hello from last turn")];
    const chatMessages = [...persisted, user("u2", "ok nice")];

    const merged = mergeDisplayMessages(
      persisted,
      chatMessages,
      staleDraft,
      true,
      false,
      true,
    );

    expect(merged.map((message) => message.id)).toEqual(["u1", "a1", "u2"]);
  });
});
