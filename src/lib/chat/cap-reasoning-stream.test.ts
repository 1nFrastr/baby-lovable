import { describe, expect, it } from "vitest";
import type { UIMessageChunk } from "ai";

import { capReasoningStream } from "./cap-reasoning-stream";
import { REASONING_TEXT_MAX_CHARS } from "./reasoning-text";

async function collect(chunks: UIMessageChunk[]): Promise<UIMessageChunk[]> {
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  }).pipeThrough(capReasoningStream());

  const out: UIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    out.push(next.value);
  }
  return out;
}

describe("capReasoningStream", () => {
  it("passes through short reasoning unchanged", async () => {
    expect(
      await collect([
        { type: "reasoning-start", id: "r0" },
        { type: "reasoning-delta", id: "r0", delta: "Inspect files first." },
        { type: "reasoning-end", id: "r0" },
      ]),
    ).toEqual([
      { type: "reasoning-start", id: "r0" },
      { type: "reasoning-delta", id: "r0", delta: "Inspect files first." },
      { type: "reasoning-end", id: "r0" },
    ]);
  });

  it("clips overflow and drops later deltas while keeping start/end", async () => {
    const chunks = await collect([
      { type: "reasoning-start", id: "r0" },
      {
        type: "reasoning-delta",
        id: "r0",
        delta: "a".repeat(REASONING_TEXT_MAX_CHARS + 80),
      },
      { type: "reasoning-delta", id: "r0", delta: "more" },
      { type: "reasoning-end", id: "r0" },
    ]);

    expect(chunks[0]).toEqual({ type: "reasoning-start", id: "r0" });
    expect(chunks[1]?.type).toBe("reasoning-delta");
    if (chunks[1]?.type === "reasoning-delta") {
      expect(chunks[1].delta.endsWith("…")).toBe(true);
      expect(chunks[1].delta.length).toBeLessThanOrEqual(
        REASONING_TEXT_MAX_CHARS + 1,
      );
    }
    expect(chunks.at(-1)).toEqual({ type: "reasoning-end", id: "r0" });
    expect(chunks).toHaveLength(3);
  });
});
