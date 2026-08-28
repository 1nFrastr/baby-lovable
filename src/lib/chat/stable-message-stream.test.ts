import { describe, expect, it } from "vitest";

import { bindAssistantMessageId } from "./stable-message-stream";

describe("bindAssistantMessageId", () => {
  it("rewrites only the start chunk onto the stable assistant id", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "start", messageId: "temp-id" });
        controller.enqueue({ type: "text-delta", id: "t1", delta: "Hi" });
        controller.close();
      },
    }).pipeThrough(bindAssistantMessageId("assistant-stable"));

    const chunks: unknown[] = [];
    const reader = stream.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      chunks.push(next.value);
    }

    expect(chunks).toEqual([
      { type: "start", messageId: "assistant-stable" },
      { type: "text-delta", id: "t1", delta: "Hi" },
    ]);
  });
});
