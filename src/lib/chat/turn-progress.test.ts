import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import { sanitizeJsonbText } from "@/lib/json/sanitize-jsonb";
import type { ModelMessage } from "ai";

import {
  appendRecordedStep,
  applyAssistantSnapshot,
  applyClosingModelText,
  applyToolProgress,
  assistantTextContent,
  completedAssistantWrite,
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

  it("caps very long reasoning so snapshots stay UI-safe", () => {
    const assistant = appendRecordedStep(
      createTurnAssistantMessage("assistant-1"),
      {
        reasoning: [{ text: "x".repeat(5_000) }],
        content: [],
      },
      new Map(),
    );

    expect(assistant.parts[1]).toMatchObject({ type: "reasoning" });
    if (assistant.parts[1]?.type === "reasoning") {
      expect(assistant.parts[1].text.endsWith("…")).toBe(true);
      expect(assistant.parts[1].text.length).toBe(4_001);
    }
  });
});

describe("joinReasoningText", () => {
  it("does not insert paragraph breaks between token fragments", () => {
    expect(
      joinReasoningText(["The", "user", " wants", " to revert."]),
    ).toBe("The user wants to revert.");
  });

  it("rejoins split emoji code units so later jsonb sanitize can keep them", () => {
    const joined = joinReasoningText(["hello", "\uD83D", "\uDE00", "world"]);
    expect(joined).toBe("hello 😀 world");
    expect(sanitizeJsonbText(joined)).toBe("hello 😀 world");
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

describe("applyClosingModelText", () => {
  const fullClose =
    "**首页**\n- 底栏\n- 播放页\n窄屏(<md)自动隐藏侧栏";

  it("replaces a shorter last text part with the model closing text", () => {
    const assistant = appendRecordedStep(
      createTurnAssistantMessage("assistant-1"),
      {
        content: [
          { type: "text", text: "- 首页\n侧边栏：窄屏..." },
        ],
      },
      new Map(),
    );

    const merged = applyClosingModelText(assistant, [
      { role: "user", content: "build" },
      { role: "assistant", content: [{ type: "text", text: fullClose }] },
    ]);

    expect(assistantTextContent(merged)).toBe(fullClose);
    expect(merged.parts.at(-1)).toMatchObject({ state: "done" });
  });

  it("keeps a longer fold when the last model assistant has no text", () => {
    const assistant = appendRecordedStep(
      createTurnAssistantMessage("assistant-1"),
      {
        content: [{ type: "text", text: "I updated the homepage." }],
      },
      new Map(),
    );
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "previous turn close that is much longer than the fold" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "writeFile",
            input: {},
          },
        ],
      },
    ];

    expect(applyClosingModelText(assistant, messages)).toBe(assistant);
  });

  it("does not duplicate a closing text the fold already contains", () => {
    const assistant = appendRecordedStep(
      createTurnAssistantMessage("assistant-1"),
      { content: [{ type: "text", text: fullClose }] },
      new Map(),
    );

    expect(
      applyClosingModelText(assistant, [
        { role: "assistant", content: fullClose },
      ]),
    ).toBe(assistant);
  });

  it("appends the closing text when the fold has no text part", () => {
    const assistant = appendRecordedStep(
      createTurnAssistantMessage("assistant-1"),
      {
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "readFile",
            input: { path: "a.ts" },
          },
        ],
      },
      new Map(),
    );

    const merged = applyClosingModelText(assistant, [
      { role: "assistant", content: "Done." },
    ]);

    expect(merged.parts.at(-1)).toMatchObject({
      type: "text",
      text: "Done.",
    });
  });
});

describe("completedAssistantWrite", () => {
  const longText =
    "**首页**\n- 底栏\n- 播放页\n窄屏(<md)自动隐藏侧栏";

  function storedThread(text: string) {
    return thread({
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "text", text, state: "done" }],
    });
  }

  it("keeps the stored body when finish has an older checkpoint", () => {
    const resolved = completedAssistantWrite({
      messages: storedThread(longText),
      snapshot: {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "- 首页", state: "done" }],
      },
      checkpoint: 1,
      storedCheckpoint: 4,
    });

    expect(resolved.checkpoint).toBe(4);
    expect(assistantTextContent(resolved.message!)).toBe(longText);
  });

  it("keeps the longer body when finish repeats the checkpoint with shorter text", () => {
    const resolved = completedAssistantWrite({
      messages: storedThread(longText),
      snapshot: {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "- 首页", state: "done" }],
      },
      checkpoint: 4,
      storedCheckpoint: 4,
    });

    expect(resolved.checkpoint).toBe(4);
    expect(assistantTextContent(resolved.message!)).toBe(longText);
  });

  it("accepts a longer closing text at the same checkpoint", () => {
    const resolved = completedAssistantWrite({
      messages: storedThread("- 首页"),
      snapshot: {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: longText, state: "done" }],
      },
      checkpoint: 4,
      storedCheckpoint: 4,
    });

    expect(assistantTextContent(resolved.message!)).toBe(longText);
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
