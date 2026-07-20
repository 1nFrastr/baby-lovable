import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";

import {
  shouldAutoContinue,
  AUTO_CONTINUE_MAX,
} from "./auto-continue";
import {
  compactModelMessages,
  estimateTokens,
} from "./context-compact";

describe("shouldAutoContinue", () => {
  it("continues on finishReason=length within budget", () => {
    expect(shouldAutoContinue("length", 0)).toBe(true);
    expect(shouldAutoContinue("length", AUTO_CONTINUE_MAX - 1)).toBe(true);
  });

  it("stops after AUTO_CONTINUE_MAX", () => {
    expect(shouldAutoContinue("length", AUTO_CONTINUE_MAX)).toBe(false);
  });

  it("continues on tool-calls when step budget is exhausted", () => {
    expect(
      shouldAutoContinue("tool-calls", 0, { stepCount: 30, maxSteps: 30 }),
    ).toBe(true);
  });

  it("does not continue on early tool-calls stops", () => {
    expect(
      shouldAutoContinue("tool-calls", 0, { stepCount: 5, maxSteps: 30 }),
    ).toBe(false);
  });

  it("does not continue on stop", () => {
    expect(shouldAutoContinue("stop", 0)).toBe(false);
  });
});

describe("compactModelMessages", () => {
  function writeFileCall(path: string, content: string): ModelMessage {
    return {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: `call_${path}`,
          toolName: "writeFile",
          input: { path, content },
        },
      ],
    };
  }

  function writeFileResult(path: string): ModelMessage {
    return {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `call_${path}`,
          toolName: "writeFile",
          output: { type: "json", value: { ok: true, path } },
        },
      ],
    } as ModelMessage;
  }

  it("leaves small histories alone", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hello" },
      writeFileCall("src/a.ts", " console.log(1)"),
    ];
    const result = compactModelMessages(messages, { tokenBudget: 100_000 });
    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual(messages);
  });

  it("truncates old writeFile payloads when over budget", () => {
    const big = "x".repeat(8_000);
    const messages: ModelMessage[] = [
      { role: "user", content: "build many files" },
    ];
    for (let i = 0; i < 20; i++) {
      messages.push(writeFileCall(`src/f${i}.ts`, big));
      messages.push(writeFileResult(`src/f${i}.ts`));
    }
    messages.push({ role: "user", content: "keep going" });

    const before = estimateTokens(messages);
    const result = compactModelMessages(messages, {
      tokenBudget: Math.floor(before / 3),
      keepRecent: 4,
    });

    expect(result.compacted).toBe(true);
    expect(result.estimatedTokens).toBeLessThan(before);

    const firstCall = result.messages[1];
    expect(firstCall?.role).toBe("assistant");
    if (firstCall?.role === "assistant" && Array.isArray(firstCall.content)) {
      const part = firstCall.content[0];
      expect(part?.type).toBe("tool-call");
      if (part?.type === "tool-call") {
        const input = part.input as { content?: string };
        expect(input.content).toMatch(/\[compacted:/);
        expect(input.content?.length ?? 0).toBeLessThan(big.length);
      }
    }
  });
});
