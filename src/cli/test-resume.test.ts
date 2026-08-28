import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import type { Session } from "@/lib/session/types";

import { validateAuthoritativeSnapshots } from "./test-resume";

function session(overrides: Partial<Session> & { messages: UIMessage[] }): Session {
  return {
    schemaVersion: 3,
    id: "sess_1",
    userId: "user_1",
    title: "Todo",
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    runStatus: "running",
    activeTurnId: "turn_1",
    activeAssistantMessageId: "assistant-1",
    conversationRevision: 1,
    turnCheckpoint: 0,
    sandboxMode: "daytona",
    ...overrides,
  };
}

const completedList: UIMessage = {
  id: "assistant-1",
  role: "assistant",
  parts: [
    { type: "step-start" },
    {
      type: "tool-listFiles",
      toolCallId: "call-list",
      state: "output-available",
      input: { path: "." },
      output: { files: [] },
    },
    {
      type: "tool-writeFile",
      toolCallId: "call-write",
      state: "input-available",
      input: { path: "src/app/page.tsx" },
    },
  ],
};

describe("validateAuthoritativeSnapshots", () => {
  it("accepts monotonic tool completion on a stable assistant id", () => {
    const running: UIMessage = {
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
      ],
    };

    expect(
      validateAuthoritativeSnapshots([
        session({
          conversationRevision: 1,
          messages: [
            {
              id: "user-1",
              role: "user",
              parts: [{ type: "text", text: "hi" }],
            },
            running,
          ],
        }),
        session({
          conversationRevision: 2,
          messages: [
            {
              id: "user-1",
              role: "user",
              parts: [{ type: "text", text: "hi" }],
            },
            completedList,
          ],
        }),
      ]),
    ).toEqual([]);
  });

  it("rejects a completed tool that later appears running", () => {
    const reverted: UIMessage = {
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
      ],
    };

    expect(
      validateAuthoritativeSnapshots([
        session({
          conversationRevision: 2,
          messages: [completedList],
        }),
        session({
          conversationRevision: 3,
          messages: [reverted],
        }),
      ]),
    ).toContain("completed tool regressed: call-list");
  });

  it("rejects a duplicated assistant bubble", () => {
    expect(
      validateAuthoritativeSnapshots([
        session({
          messages: [
            completedList,
            { ...completedList, id: "assistant-1" },
          ],
        }),
      ]),
    ).toEqual([
      "duplicate message id at revision 1",
    ]);
  });
});
