import type { FileUIPart } from "ai";

import { parseAttachmentId } from "@/lib/chat/attachments";
import {
  isPreviewElementPickPayload,
  type PreviewElementPickPayload,
} from "@/lib/preview/bridge-protocol";
import type { PreviewElementPick } from "@/lib/preview/format-preview-pick";

export const CHAT_QUEUE_STORAGE_KEY_PREFIX = "baby-lovable.chat-queue:";
export const CHAT_QUEUE_MAX_ITEMS = 20;

export interface QueuedChatMessage {
  id: string;
  text: string;
  files: FileUIPart[];
  picks: PreviewElementPick[];
  createdAt: number;
}

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function chatQueueStorageKey(sessionId: string): string {
  return `${CHAT_QUEUE_STORAGE_KEY_PREFIX}${sessionId}`;
}

export function queuedMessageHasContent(
  item: Pick<QueuedChatMessage, "text" | "files" | "picks">,
): boolean {
  return (
    item.text.trim().length > 0 ||
    item.files.length > 0 ||
    item.picks.length > 0
  );
}

/** Immediate send is blocked; composer should enqueue a follow-up instead. */
export function shouldQueueComposerSubmit(options: {
  turnLocked: boolean;
  summarizing: boolean;
}): boolean {
  return options.turnLocked && !options.summarizing;
}

function parseQueuedFile(value: unknown): FileUIPart | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.type !== "file") {
    return null;
  }
  if (typeof record.url !== "string" || parseAttachmentId(record.url) == null) {
    return null;
  }
  if (typeof record.mediaType !== "string" || record.mediaType.length === 0) {
    return null;
  }
  const file: FileUIPart = {
    type: "file",
    url: record.url,
    mediaType: record.mediaType,
  };
  if (typeof record.filename === "string" && record.filename.length > 0) {
    file.filename = record.filename;
  }
  return file;
}

function serializePick(pick: PreviewElementPick): PreviewElementPick {
  return {
    id: pick.id,
    tagName: pick.tagName,
    selector: pick.selector,
    path: pick.path,
    ...(pick.componentName ? { componentName: pick.componentName } : {}),
    ...(pick.className ? { className: pick.className } : {}),
    ...(pick.textSnippet ? { textSnippet: pick.textSnippet } : {}),
    ...(pick.ariaLabel ? { ariaLabel: pick.ariaLabel } : {}),
    ...(pick.testId ? { testId: pick.testId } : {}),
  };
}

function parseQueuedPick(
  value: unknown,
  index: number,
): PreviewElementPick | null {
  if (!isPreviewElementPickPayload(value)) {
    return null;
  }
  const payload = value as PreviewElementPickPayload & { id?: string };
  const localId =
    typeof payload.id === "string" && payload.id.length > 0
      ? payload.id
      : `pick_${index}`;
  return { ...payload, id: localId };
}

function parseQueuedMessage(value: unknown): QueuedChatMessage | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) {
    return null;
  }
  if (typeof record.text !== "string") {
    return null;
  }
  if (
    typeof record.createdAt !== "number" ||
    !Number.isFinite(record.createdAt)
  ) {
    return null;
  }

  const files = Array.isArray(record.files)
    ? record.files
        .map((file) => parseQueuedFile(file))
        .filter((file): file is FileUIPart => file != null)
    : [];
  const picks = Array.isArray(record.picks)
    ? record.picks
        .map((pick, index) => parseQueuedPick(pick, index))
        .filter((pick): pick is PreviewElementPick => pick != null)
    : [];

  const item: QueuedChatMessage = {
    id: record.id,
    text: record.text,
    files,
    picks,
    createdAt: record.createdAt,
  };
  if (!queuedMessageHasContent(item)) {
    return null;
  }
  return item;
}

export function parseChatMessageQueue(raw: string | null): QueuedChatMessage[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const items: QueuedChatMessage[] = [];
    const seen = new Set<string>();
    for (const entry of parsed) {
      if (items.length >= CHAT_QUEUE_MAX_ITEMS) {
        break;
      }
      const item = parseQueuedMessage(entry);
      if (!item || seen.has(item.id)) {
        continue;
      }
      seen.add(item.id);
      items.push(item);
    }
    return items;
  } catch {
    return [];
  }
}

export function serializeChatMessageQueue(
  items: readonly QueuedChatMessage[],
): string {
  return JSON.stringify(
    items.slice(0, CHAT_QUEUE_MAX_ITEMS).map((item) => ({
      id: item.id,
      text: item.text,
      files: item.files.map((file) => ({
        type: "file" as const,
        url: file.url,
        mediaType: file.mediaType,
        ...(file.filename ? { filename: file.filename } : {}),
      })),
      picks: item.picks.map(serializePick),
      createdAt: item.createdAt,
    })),
  );
}

export function readChatMessageQueue(
  sessionId: string,
  storage?: StorageLike | null,
): QueuedChatMessage[] {
  if (!sessionId) {
    return [];
  }
  const store =
    storage ?? (typeof window === "undefined" ? null : window.localStorage);
  if (!store) {
    return [];
  }
  try {
    return parseChatMessageQueue(store.getItem(chatQueueStorageKey(sessionId)));
  } catch {
    return [];
  }
}

export function writeChatMessageQueue(
  sessionId: string,
  items: readonly QueuedChatMessage[],
  storage?: StorageLike | null,
): void {
  if (!sessionId) {
    return;
  }
  const store =
    storage ?? (typeof window === "undefined" ? null : window.localStorage);
  if (!store) {
    return;
  }
  try {
    const key = chatQueueStorageKey(sessionId);
    if (items.length === 0) {
      store.removeItem(key);
      return;
    }
    store.setItem(key, serializeChatMessageQueue(items));
  } catch {
    // Ignore quota / private-mode failures; in-memory queue still applies.
  }
}

const EMPTY_QUEUE: QueuedChatMessage[] = [];
const memoryQueues = new Map<string, QueuedChatMessage[]>();
const queueListeners = new Map<string, Set<() => void>>();

function notifyChatMessageQueue(sessionId: string): void {
  const listeners = queueListeners.get(sessionId);
  if (!listeners) {
    return;
  }
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeChatMessageQueue(
  sessionId: string,
  listener: () => void,
): () => void {
  let listeners = queueListeners.get(sessionId);
  if (!listeners) {
    listeners = new Set();
    queueListeners.set(sessionId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      queueListeners.delete(sessionId);
    }
  };
}

export function getChatMessageQueueSnapshot(
  sessionId: string,
): QueuedChatMessage[] {
  if (!sessionId) {
    return EMPTY_QUEUE;
  }
  const cached = memoryQueues.get(sessionId);
  if (cached) {
    return cached;
  }
  const loaded = readChatMessageQueue(sessionId);
  const snapshot = loaded.length === 0 ? EMPTY_QUEUE : loaded;
  memoryQueues.set(sessionId, snapshot);
  return snapshot;
}

export function getEmptyChatMessageQueue(): QueuedChatMessage[] {
  return EMPTY_QUEUE;
}

export function replaceChatMessageQueue(
  sessionId: string,
  updater: (prev: QueuedChatMessage[]) => QueuedChatMessage[],
): QueuedChatMessage[] {
  const prev = getChatMessageQueueSnapshot(sessionId);
  const next = updater(prev);
  if (next === prev) {
    return prev;
  }
  memoryQueues.set(sessionId, next.length === 0 ? EMPTY_QUEUE : next);
  writeChatMessageQueue(sessionId, next);
  notifyChatMessageQueue(sessionId);
  return next;
}
