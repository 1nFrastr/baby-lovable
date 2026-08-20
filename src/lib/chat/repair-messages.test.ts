import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";

import { isEmptyUiMessage, repairUiMessages } from "./repair-messages";

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function assistant(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

describe("repairUiMessages", () => {
  it("merges consecutive user messages from a failed turn", () => {
    const result = repairUiMessages([
      user("u1", "build a todo app"),
      user("u2", "make it colorful"),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("u2");
    expect(result[0]?.parts).toEqual([
      { type: "text", text: "build a todo app\n\nmake it colorful" },
    ]);
  });

  it("collapses duplicate user retries with the same text", () => {
    const result = repairUiMessages([
      user("u1", "retry this"),
      user("u2", "retry this"),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("u2");
    expect(result[0]?.parts).toEqual([{ type: "text", text: "retry this" }]);
  });

  it("drops an interrupted assistant then merges the surrounding users", () => {
    const interrupted: UIMessage = {
      id: "a-partial",
      role: "assistant",
      parts: [
        {
          type: "tool-writeFile",
          toolCallId: "call_1",
          state: "input-available",
          input: { path: "src/app/page.tsx" },
        },
      ],
    };

    const result = repairUiMessages([
      user("u1", "add a sidebar"),
      interrupted,
      user("u2", "try again"),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.parts[0]).toMatchObject({
      type: "text",
      text: "add a sidebar\n\ntry again",
    });
  });

  it("drops leading assistant leftovers", () => {
    const result = repairUiMessages([
      assistant("a0", "orphan"),
      user("u1", "hello"),
      assistant("a1", "hi"),
    ]);

    expect(result.map((message) => message.id)).toEqual(["u1", "a1"]);
  });

  it("keeps a well-formed alternating thread unchanged", () => {
    const messages = [
      user("u1", "hello"),
      assistant("a1", "hi"),
      user("u2", "next"),
      assistant("a2", "ok"),
    ];

    expect(repairUiMessages(messages)).toEqual(messages);
  });

  it("treats whitespace-only user rows as empty", () => {
    expect(isEmptyUiMessage(user("u", "   \n"))).toBe(true);
  });
});
