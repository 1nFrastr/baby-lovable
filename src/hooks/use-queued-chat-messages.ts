"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

import {
  CHAT_QUEUE_MAX_ITEMS,
  getChatMessageQueueSnapshot,
  getEmptyChatMessageQueue,
  queuedMessageHasContent,
  replaceChatMessageQueue,
  subscribeChatMessageQueue,
  type QueuedChatMessage,
} from "@/lib/chat/message-queue";

export function useQueuedChatMessages(sessionId: string) {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribeChatMessageQueue(sessionId, onStoreChange),
    [sessionId],
  );
  const getSnapshot = useCallback(
    () => getChatMessageQueueSnapshot(sessionId),
    [sessionId],
  );
  const items = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getEmptyChatMessageQueue,
  );

  const enqueue = useCallback(
    (item: QueuedChatMessage): boolean => {
      if (!queuedMessageHasContent(item)) {
        return false;
      }
      let added = false;
      replaceChatMessageQueue(sessionId, (prev) => {
        if (
          prev.length >= CHAT_QUEUE_MAX_ITEMS ||
          prev.some((entry) => entry.id === item.id)
        ) {
          return prev;
        }
        added = true;
        return [...prev, item];
      });
      return added;
    },
    [sessionId],
  );

  const remove = useCallback(
    (id: string) => {
      replaceChatMessageQueue(sessionId, (prev) => {
        if (!prev.some((item) => item.id === id)) {
          return prev;
        }
        return prev.filter((item) => item.id !== id);
      });
    },
    [sessionId],
  );

  const update = useCallback(
    (
      id: string,
      patch: Partial<Pick<QueuedChatMessage, "text" | "files" | "picks">>,
    ) => {
      replaceChatMessageQueue(sessionId, (prev) => {
        let changed = false;
        const next: QueuedChatMessage[] = [];
        for (const item of prev) {
          if (item.id !== id) {
            next.push(item);
            continue;
          }
          changed = true;
          const merged = { ...item, ...patch };
          if (queuedMessageHasContent(merged)) {
            next.push(merged);
          }
        }
        return changed ? next : prev;
      });
    },
    [sessionId],
  );

  return useMemo(
    () => ({ items, enqueue, remove, update }),
    [enqueue, items, remove, update],
  );
}
