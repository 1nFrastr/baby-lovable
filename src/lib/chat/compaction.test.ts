import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";

import {
  buildCompactionUserPrompt,
  createCompactionNail,
  createCompactionSummary,
  filterCompacted,
  groupMessagesForDisplay,
  insertCompactionBefore,
  isCompactionMessage,
  isSummaryMessage,
  planCompaction,
} from "./compaction";

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function assistant(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

function compactedLedger(options?: {
  tailStartId?: string;
  extra?: UIMessage[];
}): UIMessage[] {
  const nail = createCompactionNail({
    turnId: "turn_1",
    auto: true,
    overflow: true,
    tailStartId: options?.tailStartId,
  });
  const summary = createCompactionSummary({
    turnId: "turn_1",
    text: "## Goal\n- Ship the todo app",
  });
  return [
    user("u1", "build a todo app"),
    assistant("a1", "created page"),
    user("u2", "add colors"),
    assistant("a2", "added palette"),
    user("u3", "add tests"),
    assistant("a3", "skipped tests"),
    user("u4", "keep going"),
    assistant("a4", "working"),
    nail,
    summary,
    ...(options?.extra ?? []),
  ];
}

describe("compaction markers", () => {
  it("recognizes nails and summaries", () => {
    const nail = createCompactionNail({
      turnId: "t",
      auto: true,
      tailStartId: "u4",
    });
    const summary = createCompactionSummary({ turnId: "t", text: "hello" });
    expect(isCompactionMessage(nail)).toBe(true);
    expect(isSummaryMessage(summary)).toBe(true);
    expect(isCompactionMessage(user("u", "hi"))).toBe(false);
    expect(isSummaryMessage(assistant("a", "hi"))).toBe(false);
  });
});

describe("filterCompacted", () => {
  it("returns the original thread when there is no nail", () => {
    const messages = [
      user("u1", "hello"),
      assistant("a1", "hi"),
      user("u2", "next"),
    ];
    expect(filterCompacted(messages).map((message) => message.id)).toEqual([
      "u1",
      "a1",
      "u2",
    ]);
  });

  it("drops history before a nail when no tail is set", () => {
    const messages = compactedLedger();
    expect(filterCompacted(messages).map((message) => message.id)).toEqual([
      "csm_turn_1",
    ]);
  });

  it("reorders to summary + tail + post-compaction messages", () => {
    const messages = compactedLedger({
      tailStartId: "u4",
      extra: [user("u5", "now add a gradient")],
    });
    expect(filterCompacted(messages).map((message) => message.id)).toEqual([
      "csm_turn_1",
      "u4",
      "a4",
      "u5",
    ]);
  });

  it("only honors the latest completed compaction", () => {
    const first = compactedLedger({
      tailStartId: "u2",
      extra: [
        user("u5", "more work"),
        assistant("a5", "done more"),
        createCompactionNail({
          turnId: "turn_2",
          auto: true,
          tailStartId: "u5",
        }),
        createCompactionSummary({
          turnId: "turn_2",
          text: "## Goal\n- Keep iterating",
        }),
        user("u6", "one more thing"),
      ],
    });
    expect(filterCompacted(first).map((message) => message.id)).toEqual([
      "csm_turn_2",
      "u5",
      "a5",
      "u6",
    ]);
  });

  it("ignores a nail without a completed summary", () => {
    const messages = [
      user("u1", "hello"),
      assistant("a1", "hi"),
      createCompactionNail({ turnId: "orphan", auto: true, tailStartId: "u1" }),
      user("u2", "continue"),
    ];
    expect(filterCompacted(messages).map((message) => message.id)).toEqual([
      "u1",
      "a1",
      "u2",
    ]);
  });
});

describe("planCompaction / insertCompactionBefore", () => {
  it("keeps the last N filtered messages as the tail", () => {
    const messages = [
      user("u1", "a"),
      assistant("a1", "b"),
      user("u2", "c"),
      assistant("a2", "d"),
      user("u3", "e"),
    ];
    const plan = planCompaction(messages, 2);
    expect(plan.needed).toBe(true);
    expect(plan.tail.map((message) => message.id)).toEqual(["u2", "a2"]);
    expect(plan.tailStartId).toBe("u2");
    expect(plan.currentUser?.id).toBe("u3");
    expect(plan.head.map((message) => message.id)).toEqual(["u1", "a1"]);
  });

  it("inserts the nail and summary immediately before the current user", () => {
    const messages = [user("u1", "a"), assistant("a1", "b"), user("u2", "c")];
    const nail = createCompactionNail({
      turnId: "t",
      auto: true,
      tailStartId: "a1",
    });
    const summary = createCompactionSummary({ turnId: "t", text: "sum" });
    expect(
      insertCompactionBefore(messages, "u2", nail, summary).map(
        (message) => message.id,
      ),
    ).toEqual(["u1", "a1", "cmp_t", "csm_t", "u2"]);
  });
});

describe("groupMessagesForDisplay", () => {
  it("seals messages before the tail and keeps divider, summary, and tail", () => {
    const messages = compactedLedger({
      tailStartId: "u4",
      extra: [user("u5", "now add a gradient")],
    });
    const items = groupMessagesForDisplay(messages);
    expect(items.map((item) => item.type)).toEqual([
      "sealed",
      "divider",
      "summary",
      "message",
      "message",
      "message",
    ]);
    expect(items[0]).toMatchObject({ type: "sealed" });
    if (items[0]?.type === "sealed") {
      expect(items[0].messages.map((message) => message.id)).toEqual([
        "u1",
        "a1",
        "u2",
        "a2",
        "u3",
        "a3",
      ]);
    }
    expect(items[1]).toMatchObject({ type: "divider", message: { id: "cmp_turn_1" } });
    expect(items[2]).toMatchObject({ type: "summary", message: { id: "csm_turn_1" } });
  });
});

describe("buildCompactionUserPrompt", () => {
  it("includes previous summary and omits nails from the transcript", () => {
    const prompt = buildCompactionUserPrompt({
      head: [
        user("u1", "build a todo app"),
        assistant("a1", "created src/app/page.tsx"),
        createCompactionNail({ turnId: "old", auto: true }),
        createCompactionSummary({ turnId: "old", text: "old summary" }),
      ],
      previousSummary: "## Goal\n- Todo app",
    });
    expect(prompt).toContain("<previous-summary>");
    expect(prompt).toContain("## Goal\n- Todo app");
    expect(prompt).toContain("build a todo app");
    expect(prompt).toContain("src/app/page.tsx");
    expect(prompt).not.toContain("data-compaction");
  });
});
