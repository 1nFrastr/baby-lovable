import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";

import {
  INTERRUPTED_BY_USER,
  assistantHasPersistedContent,
  finalizeInterruptedAssistant,
  finalizeInterruptedMessages,
} from "./interrupt-assistant";

function assistant(parts: UIMessage["parts"]): UIMessage {
  return { id: "a1", role: "assistant", parts };
}

describe("finalizeInterruptedAssistant", () => {
  it("marks in-flight tools as output-error", () => {
    const result = finalizeInterruptedAssistant(
      assistant([
        {
          type: "tool-writeFile",
          toolCallId: "call_1",
          state: "input-available",
          input: { path: "src/app/page.tsx" },
        },
      ]),
    );

    expect(result.parts[0]).toMatchObject({
      type: "tool-writeFile",
      state: "output-error",
      errorText: INTERRUPTED_BY_USER,
      input: { path: "src/app/page.tsx" },
    });
  });

  it("marks streaming text as done and leaves completed tools alone", () => {
    const result = finalizeInterruptedAssistant(
      assistant([
        { type: "text", text: "Working on it", state: "streaming" },
        {
          type: "tool-readFile",
          toolCallId: "call_2",
          state: "output-available",
          input: { path: "src/app/page.tsx" },
          output: { content: "ok" },
        },
      ]),
    );

    expect(result.parts[0]).toMatchObject({
      type: "text",
      text: "Working on it",
      state: "done",
    });
    expect(result.parts[1]).toMatchObject({
      state: "output-available",
      output: { content: "ok" },
    });
  });

  it("finalizes reasoning + incomplete edit so Editing cannot linger", () => {
    const result = finalizeInterruptedAssistant(
      assistant([
        {
          type: "reasoning",
          text: "Thought for 1 second",
          state: "done",
        },
        {
          type: "tool-editFile",
          toolCallId: "call_3",
          state: "input-available",
          input: {
            path: "src/components/todo/Todo.tsx",
            old_string: "a",
            new_string: "b",
          },
        },
      ]),
    );

    expect(result.parts[1]).toMatchObject({
      type: "tool-editFile",
      state: "output-error",
      errorText: INTERRUPTED_BY_USER,
    });
  });
});

describe("finalizeInterruptedMessages", () => {
  it("seals only assistants that still have in-flight parts", () => {
    const messages: UIMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "add slogan" }],
      },
      assistant([
        {
          type: "tool-editFile",
          toolCallId: "call_1",
          state: "input-available",
          input: { path: "src/app/page.tsx" },
        },
      ]),
    ];

    const sealed = finalizeInterruptedMessages(messages);
    expect(sealed[1]?.parts[0]).toMatchObject({
      state: "output-error",
      errorText: INTERRUPTED_BY_USER,
    });
    expect(finalizeInterruptedMessages(sealed)).toBe(sealed);
  });
});

describe("assistantHasPersistedContent", () => {
  it("is false for an empty assistant", () => {
    expect(assistantHasPersistedContent(assistant([]))).toBe(false);
    expect(
      assistantHasPersistedContent(
        assistant([{ type: "text", text: "   " }]),
      ),
    ).toBe(false);
  });

  it("is true after in-flight tools are finalized", () => {
    const finalized = finalizeInterruptedAssistant(
      assistant([
        {
          type: "tool-writeFile",
          toolCallId: "call_1",
          state: "input-available",
          input: { path: "src/app/page.tsx" },
        },
      ]),
    );
    expect(assistantHasPersistedContent(finalized)).toBe(true);
  });
});
