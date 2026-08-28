import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  appendRecordedStep,
  applyAssistantSnapshot,
  applyToolProgress,
  createTurnAssistantMessage,
  finalizeTurnForCancellation,
  joinReasoningText,
  type OrderedToolCall,
  type ToolCompletion,
} from "./turn-progress";

function thread(assistant = createTurnAssistantMessage("assistant-1")) {
  return [
    {
      id: "user-1",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "Build it" }],
    },
    assistant,
  ];
}

const calls: OrderedToolCall[] = [
  {
    toolCallId: "call-list",
    toolName: "listFiles",
    input: { path: "." },
  },
  {
    toolCallId: "call-write",
    toolName: "writeFile",
    input: { path: "src/app/page.tsx" },
  },
];

describe("applyToolProgress", () => {
  it("materializes the model call order and completes one tool in place", () => {
    const started = applyToolProgress(thread(), "assistant-1", { calls });
    const completed = applyToolProgress(
      started,
      "assistant-1",
      {
        calls,
        completedCallId: "call-write",
        completion: { success: true, output: { ok: true } },
      },
    );

    const assistant = completed.at(-1)!;
    expect(assistant.parts.map((part) => part.type)).toEqual([
      "step-start",
      "tool-listFiles",
      "tool-writeFile",
    ]);
    expect(assistant.parts[2]).toMatchObject({
      toolCallId: "call-write",
      state: "output-available",
      output: { ok: true },
    });
  });

  it("never downgrades a terminal tool when a start event is replayed", () => {
    const completed = applyToolProgress(
      thread(),
      "assistant-1",
      {
        calls,
        completedCallId: "call-list",
        completion: { success: true, output: { files: [] } },
      },
    );
    const replayed = applyToolProgress(completed, "assistant-1", {
      calls,
    });

    expect(replayed.at(-1)?.parts[1]).toMatchObject({
      toolCallId: "call-list",
      state: "output-available",
    });
  });
});

describe("appendRecordedStep", () => {
  it("uses step content order and callback tool outputs", () => {
    const completions = new Map<string, ToolCompletion>([
      ["call-list", { success: true, output: { files: ["a.ts"] } }],
      ["call-write", { success: false, errorText: "write failed" }],
    ]);
    const assistant = appendRecordedStep(
      createTurnAssistantMessage("assistant-1"),
      {
        reasoning: [{ text: "Inspect first" }],
        content: [
          { type: "text", text: "I will inspect." },
          {
            type: "tool-call",
            toolCallId: "call-list",
            toolName: "listFiles",
            input: { path: "." },
          },
          {
            type: "tool-call",
            toolCallId: "call-write",
            toolName: "writeFile",
            input: { path: "src/app/page.tsx" },
          },
        ],
      },
      completions,
    );

    expect(assistant.parts.map((part) => part.type)).toEqual([
      "step-start",
      "reasoning",
      "text",
      "tool-listFiles",
      "tool-writeFile",
    ]);
    expect(assistant.parts[3]).toMatchObject({
      state: "output-available",
    });
    expect(assistant.parts[4]).toMatchObject({
      state: "output-error",
      errorText: "write failed",
    });
  });

  it("collapses token-sized reasoning parts into one paragraph", () => {
    const assistant = appendRecordedStep(
      createTurnAssistantMessage("assistant-1"),
      {
        reasoning: [
          { text: "The" },
          { text: "user" },
          { text: " wants to revert." },
        ],
        content: [],
      },
      new Map(),
    );

    expect(
      assistant.parts.filter((part) => part.type === "reasoning"),
    ).toHaveLength(1);
    expect(assistant.parts[1]).toMatchObject({
      type: "reasoning",
      text: "The user wants to revert.",
    });
  });
});

describe("joinReasoningText", () => {
  it("does not insert paragraph breaks between token fragments", () => {
    expect(
      joinReasoningText(["The", "user", " wants", " to revert."]),
    ).toBe("The user wants to revert.");
  });
});

describe("applyAssistantSnapshot", () => {
  it("preserves a completed tool against a newer running fragment", () => {
    const completed = applyToolProgress(
      thread(),
      "assistant-1",
      {
        calls,
        completedCallId: "call-list",
        completion: { success: true, output: { files: [] } },
      },
    );
    const snapshot: UIMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "tool-listFiles",
          toolCallId: "call-list",
          state: "input-available",
          input: { path: "." },
        },
        {
          type: "tool-writeFile",
          toolCallId: "call-write",
          state: "output-available",
          input: { path: "src/app/page.tsx" },
          output: { ok: true },
        },
      ],
    };

    const merged = applyAssistantSnapshot(completed, snapshot);
    expect(merged.at(-1)?.parts[1]).toMatchObject({
      state: "output-available",
    });
  });

  it("fails closed if a newer snapshot drops a completed tool", () => {
    const completed = applyToolProgress(
      thread(),
      "assistant-1",
      {
        calls,
        completedCallId: "call-list",
        completion: { success: true, output: { files: [] } },
      },
    );

    expect(() =>
      applyAssistantSnapshot(completed, {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "missing tool" }],
      }),
    ).toThrow("omitted completed tool");
  });
});

describe("finalizeTurnForCancellation", () => {
  it("keeps server terminal tools and interrupts the live running tool", () => {
    const authoritative = applyToolProgress(
      thread(),
      "assistant-1",
      {
        calls,
        completedCallId: "call-list",
        completion: { success: true, output: { files: [] } },
      },
    ).at(-1)!;
    const client: UIMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "tool-listFiles",
          toolCallId: "call-list",
          state: "input-available",
          input: { path: "." },
        },
        {
          type: "tool-writeFile",
          toolCallId: "call-write",
          state: "input-available",
          input: { path: "src/app/page.tsx" },
        },
        { type: "text", text: "partial", state: "streaming" },
      ],
    };

    const finalized = finalizeTurnForCancellation(
      authoritative,
      client,
    );
    expect(finalized.parts[1]).toMatchObject({
      toolCallId: "call-list",
      state: "output-available",
    });
    expect(finalized.parts[2]).toMatchObject({
      toolCallId: "call-write",
      state: "output-error",
      errorText: "Interrupted by user",
    });
    expect(finalized.parts[3]).toMatchObject({ state: "done" });
  });
});
