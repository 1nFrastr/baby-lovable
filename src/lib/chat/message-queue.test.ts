import { describe, expect, it } from "vitest";

import {
  CHAT_QUEUE_MAX_ITEMS,
  chatQueueStorageKey,
  getChatMessageQueueSnapshot,
  parseChatMessageQueue,
  queuedMessageHasContent,
  readChatMessageQueue,
  replaceChatMessageQueue,
  serializeChatMessageQueue,
  shouldQueueComposerSubmit,
  writeChatMessageQueue,
  type QueuedChatMessage,
  type StorageLike,
} from "./message-queue";

function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const data = { ...initial };
  return {
    getItem(key) {
      return data[key] ?? null;
    },
    setItem(key, value) {
      data[key] = value;
    },
    removeItem(key) {
      delete data[key];
    },
  };
}

const sample: QueuedChatMessage = {
  id: "q_1",
  text: "Add dark mode",
  files: [
    {
      type: "file",
      url: "attachment://att_abc",
      mediaType: "image/png",
      filename: "shot.png",
    },
  ],
  picks: [
    {
      id: "pick_1",
      tagName: "button",
      selector: "button:nth-of-type(2)",
      path: "/",
      componentName: "TodoItem",
    },
  ],
  createdAt: 1_700_000_000_000,
};

describe("chat message queue", () => {
  it("round-trips a queued follow-up", () => {
    const parsed = parseChatMessageQueue(serializeChatMessageQueue([sample]));
    expect(parsed).toEqual([sample]);
  });

  it("drops blob/data file URLs that cannot survive a refresh", () => {
    const parsed = parseChatMessageQueue(
      JSON.stringify([
        {
          id: "q_blob",
          text: "Keep the text",
          files: [
            {
              type: "file",
              url: "blob:https://localhost/1",
              mediaType: "image/png",
              filename: "lost.png",
            },
          ],
          picks: [],
          createdAt: 1,
        },
      ]),
    );
    expect(parsed).toEqual([
      {
        id: "q_blob",
        text: "Keep the text",
        files: [],
        picks: [],
        createdAt: 1,
      },
    ]);
  });

  it("drops empty items and duplicate ids", () => {
    const parsed = parseChatMessageQueue(
      JSON.stringify([
        { id: "q_empty", text: "  ", files: [], picks: [], createdAt: 1 },
        sample,
        { ...sample, text: "Duplicate" },
      ]),
    );
    expect(parsed.map((item) => item.id)).toEqual(["q_1"]);
  });

  it("caps stored length", () => {
    const items: QueuedChatMessage[] = Array.from(
      { length: CHAT_QUEUE_MAX_ITEMS + 5 },
      (_, index) => ({
        id: `q_${index}`,
        text: `item ${index}`,
        files: [],
        picks: [],
        createdAt: index,
      }),
    );
    const parsed = parseChatMessageQueue(serializeChatMessageQueue(items));
    expect(parsed).toHaveLength(CHAT_QUEUE_MAX_ITEMS);
    expect(parsed[0]?.id).toBe("q_0");
  });

  it("returns false for empty content", () => {
    expect(
      queuedMessageHasContent({ text: "  ", files: [], picks: [] }),
    ).toBe(false);
    expect(
      queuedMessageHasContent({ text: "hi", files: [], picks: [] }),
    ).toBe(true);
  });

  it("queues while a turn is locked but not while summarizing", () => {
    expect(
      shouldQueueComposerSubmit({ turnLocked: true, summarizing: false }),
    ).toBe(true);
    expect(
      shouldQueueComposerSubmit({ turnLocked: true, summarizing: true }),
    ).toBe(false);
    expect(
      shouldQueueComposerSubmit({ turnLocked: false, summarizing: false }),
    ).toBe(false);
  });

  it("reads and writes per session in storage", () => {
    const storage = memoryStorage();
    writeChatMessageQueue("sess_a", [sample], storage);
    writeChatMessageQueue("sess_b", [], storage);
    expect(readChatMessageQueue("sess_a", storage)).toEqual([sample]);
    expect(readChatMessageQueue("sess_b", storage)).toEqual([]);
    expect(storage.getItem(chatQueueStorageKey("sess_b"))).toBeNull();
  });

  it("notifies the in-memory snapshot used by the composer", () => {
    const id = `sess_${Math.random().toString(16).slice(2)}`;
    expect(getChatMessageQueueSnapshot(id)).toEqual([]);
    replaceChatMessageQueue(id, () => [sample]);
    expect(getChatMessageQueueSnapshot(id)).toEqual([sample]);
    replaceChatMessageQueue(id, () => []);
    expect(getChatMessageQueueSnapshot(id)).toEqual([]);
  });

  it("ignores corrupt storage JSON", () => {
    expect(parseChatMessageQueue("{")).toEqual([]);
    expect(parseChatMessageQueue(JSON.stringify({ items: [sample] }))).toEqual(
      [],
    );
  });
});
