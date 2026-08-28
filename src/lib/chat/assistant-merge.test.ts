import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  mergeAssistantMonotonically,
  overlayLiveTextTail,
} from "./assistant-merge";

function assistant(parts: UIMessage["parts"], id = "a1"): UIMessage {
  return { id, role: "assistant", parts };
}

describe("mergeAssistantMonotonically", () => {
  it("never downgrades a completed tool to in-progress", () => {
    const authoritative = assistant([
      {
        type: "tool-writeFile",
        toolCallId: "call_1",
        state: "output-available",
        input: { path: "src/app/page.tsx" },
        output: { ok: true },
      },
    ]);

    const incoming = assistant([
      {
        type: "tool-writeFile",
        toolCallId: "call_1",
        state: "input-available",
        input: { path: "src/app/page.tsx" },
      },
    ]);

    const merged = mergeAssistantMonotonically(authoritative, incoming);
    expect(merged.parts[0]).toMatchObject({ state: "output-available" });
  });
});

describe("overlayLiveTextTail", () => {
  it("overlays longer live text while keeping authoritative tools", () => {
    const authoritative = assistant(
      [
        {
          type: "tool-checkPreview",
          toolCallId: "call_1",
          state: "output-available",
          input: {},
          output: { ok: true },
        },
      ],
      "a-stable",
    );

    const live = assistant(
      [{ type: "text", text: "All done — preview is healthy." }],
      "a-sse",
    );

    const merged = overlayLiveTextTail(authoritative, live);
    expect(merged.id).toBe("a-stable");
    expect(merged.parts).toEqual([
      { type: "text", text: "All done — preview is healthy." },
      {
        type: "tool-checkPreview",
        toolCallId: "call_1",
        state: "output-available",
        input: {},
        output: { ok: true },
      },
    ]);
  });
});
