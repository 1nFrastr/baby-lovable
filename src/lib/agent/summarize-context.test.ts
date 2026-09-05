import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";

import {
  buildConversationTranscript,
  canSummarizeMessages,
  CONTEXT_SUMMARY_HEADING,
  CONTEXT_SUMMARY_KIND,
  isContextSummaryMessage,
  summarizeMessages,
  SummarizeContextError,
} from "./summarize-context";

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function assistant(
  id: string,
  text: string,
  tools: UIMessage["parts"] = [],
): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }, ...tools],
  };
}

function writeFilePart(path: string, content: string): UIMessage["parts"][number] {
  return {
    type: "tool-writeFile",
    toolCallId: `call_${path}`,
    state: "output-available",
    input: { path, content },
    output: { ok: true, path },
  } as UIMessage["parts"][number];
}

describe("summarizeMessages", () => {
  it("rejects empty or tiny threads", async () => {
    await expect(summarizeMessages([])).rejects.toBeInstanceOf(
      SummarizeContextError,
    );
    await expect(
      summarizeMessages([user("u1", "hi")]),
    ).rejects.toMatchObject({ code: "not_enough_history" });
  });

  it("replaces older turns with a summary and keeps recent messages", async () => {
    const messages: UIMessage[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push(user(`u${i}`, `please add file ${i}`));
      messages.push(
        assistant(`a${i}`, `wrote file ${i}`, [
          writeFilePart(`src/f${i}.ts`, "x".repeat(4_000)),
        ]),
      );
    }

    const result = await summarizeMessages(messages, {
      keepRecent: 4,
      generateSummary: async () =>
        "User goal: add files\nDone: wrote src/f0.ts through src/f5.ts",
    });

    expect(result.droppedMessageCount).toBeGreaterThan(0);
    expect(result.estimatedTokensAfter).toBeLessThan(result.estimatedTokensBefore);
    expect(isContextSummaryMessage(result.messages[0]!)).toBe(true);
    expect(result.messages[0]?.metadata).toMatchObject({
      kind: CONTEXT_SUMMARY_KIND,
    });
    expect(textOf(result.messages[0]!)).toContain(CONTEXT_SUMMARY_HEADING);
    expect(result.messages.slice(1).map((message) => message.id)).toEqual(
      messages.slice(-4).map((message) => message.id),
    );
  });

  it("falls back when the summarizer returns empty text", async () => {
    const messages = [
      user("u1", "Build a todo app"),
      assistant("a1", "Created src/app/page.tsx", [
        writeFilePart("src/app/page.tsx", "x".repeat(2_000)),
      ]),
      user("u2", "Add filters"),
      assistant("a2", "Added filters"),
    ];

    const result = await summarizeMessages(messages, {
      keepRecent: 2,
      generateSummary: async () => "   ",
    });

    expect(textOf(result.messages[0]!)).toContain("Build a todo app");
    expect(textOf(result.messages[0]!)).toContain("src/app/page.tsx");
  });

  it("builds a compact transcript without file payloads", () => {
    const transcript = buildConversationTranscript([
      user("u1", "Build a todo app"),
      assistant("a1", "Working", [
        writeFilePart("src/app/page.tsx", "SECRET_PAYLOAD"),
      ]),
    ]);
    expect(transcript).toContain("User: Build a todo app");
    expect(transcript).toContain("[writeFile src/app/page.tsx]");
    expect(transcript).not.toContain("SECRET_PAYLOAD");
  });

  it("canSummarizeMessages is true for long tool-heavy turns", () => {
    const messages = [
      user("u1", "go"),
      assistant("a1", "done", [
        writeFilePart("src/a.ts", "x".repeat(8_000)),
      ]),
    ];
    expect(canSummarizeMessages(messages, { keepRecent: 8 })).toBe(true);
  });
});

function textOf(message: UIMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<UIMessage["parts"][number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}
