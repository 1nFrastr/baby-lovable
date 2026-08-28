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
  it("returns authoritative messages between turns", () => {
    const persisted = [user("u1", "hi"), assistant("a1", "hello")];
    const chatMessages = persisted;

    const merged = mergeDisplayMessages(persisted, chatMessages, false);

    expect(merged.map((message) => message.id)).toEqual(["u1", "a1"]);
  });

  it("overlays live text tail on the authoritative assistant during a live turn", () => {
    const persisted = [user("u1", "hi"), assistant("a1", "partial")];
    const chatMessages = [user("u1", "hi"), assistant("a-sse", "partial streamed more")];

    const merged = mergeDisplayMessages(persisted, chatMessages, true);

    expect(merged.map((message) => message.id)).toEqual(["u1", "a1"]);
    expect(merged.at(-1)?.parts).toEqual([
      { type: "text", text: "partial streamed more" },
    ]);
  });

  it("keeps completed tools from the authoritative snapshot during live overlay", () => {
    const persistedAssistant = assistant("a1", "");
    persistedAssistant.parts = [
      {
        type: "tool-checkPreview",
        toolCallId: "call_1",
        state: "output-available",
        input: {},
        output: { ok: true },
      },
    ];

    const chatAssistant = assistant("a-sse", "Preview is ready.");
    chatAssistant.parts = [
      {
        type: "tool-checkPreview",
        toolCallId: "call_1",
        state: "input-available",
        input: {},
      },
      { type: "text", text: "Preview is ready." },
    ];

    const persisted = [user("u1", "Build a todo app"), persistedAssistant];
    const chatMessages = [user("u1", "Build a todo app"), chatAssistant];

    const merged = mergeDisplayMessages(persisted, chatMessages, true);

    const last = merged.at(-1);
    expect(last?.id).toBe("a1");
    expect(
      last?.parts.some(
        (part) =>
          part.type === "tool-checkPreview" &&
          part.state === "output-available",
      ),
    ).toBe(true);
    expect(
      last?.parts.some(
        (part) =>
          part.type === "text" &&
          part.text.includes("Preview is ready"),
      ),
    ).toBe(true);
  });

  it("does not duplicate assistants when SSE uses a different id", () => {
    const persisted = [user("u1", "hi"), assistant("a1", "hello")];
    const chatMessages = [...persisted, user("u2", "again")];

    const merged = mergeDisplayMessages(persisted, chatMessages, true);

    expect(merged.map((message) => message.id)).toEqual(["u1", "a1", "u2"]);
  });
});
