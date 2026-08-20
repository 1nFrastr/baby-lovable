import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";

import {
  INTERRUPTED_BY_USER,
  assistantHasPersistedContent,
  finalizeInterruptedAssistant,
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
