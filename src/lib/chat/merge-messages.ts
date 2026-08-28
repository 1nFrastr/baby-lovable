import type { UIMessage } from "ai";

import {
  lastAssistantMessage,
  overlayLiveTextTail,
  upsertAssistantInMessages,
} from "./assistant-merge";
import { finalizeInterruptedMessages } from "./interrupt-assistant";
import { repairUiMessages } from "./repair-messages";

function lastMessage(messages: UIMessage[]): UIMessage | undefined {
  return messages[messages.length - 1];
}

/**
 * useChat keeps the SSE assistant id; the server persists a stable assistant id.
 * Skip the extra client-only assistant when persisted already ended with one.
 */
function shouldSkipStaleClientAssistant(
  ordered: UIMessage[],
  message: UIMessage,
): boolean {
  return (
    message.role === "assistant" && lastMessage(ordered)?.role === "assistant"
  );
}

/** Remove back-to-back assistant rows (stale SSE id + saved stable id). */
export function dedupeConsecutiveAssistants(
  messages: UIMessage[],
): UIMessage[] {
  const ordered: UIMessage[] = [];

  for (const message of messages) {
    if (shouldSkipStaleClientAssistant(ordered, message)) {
      continue;
    }
    ordered.push(message);
  }

  return ordered;
}

function sealThread(messages: UIMessage[]): UIMessage[] {
  return repairUiMessages(
    finalizeInterruptedMessages(dedupeConsecutiveAssistants(messages)),
  );
}

/**
 * Merge client thread with server-persisted history.
 * Client may omit completed assistant messages between turns; server wins for
 * known ids, then appends any client-only messages (e.g. a new user turn).
 */
export function mergeClientMessagesWithPersisted(
  persisted: UIMessage[],
  client: UIMessage[],
): UIMessage[] {
  if (client.length === 0) {
    return sealThread(persisted);
  }

  const byId = new Map(persisted.map((message) => [message.id, message]));

  for (const message of client) {
    byId.set(message.id, message);
  }

  const ordered: UIMessage[] = [];
  const seen = new Set<string>();

  for (const message of persisted) {
    ordered.push(byId.get(message.id) ?? message);
    seen.add(message.id);
  }

  for (const message of client) {
    if (seen.has(message.id)) {
      continue;
    }

    if (shouldSkipStaleClientAssistant(ordered, message)) {
      continue;
    }

    ordered.push(message);
    seen.add(message.id);
  }

  return sealThread(ordered);
}

function liveAssistantFromChat(chatMessages: UIMessage[]): UIMessage | null {
  const last = lastMessage(chatMessages);
  return last?.role === "assistant" ? last : null;
}

/**
 * Authoritative read model: persisted messages are the source of truth.
 * While connected to the live SSE stream, overlay only unpersisted text on the
 * last assistant and append any optimistic client-only tail (e.g. a new user
 * message before the server refetch lands).
 */
export function mergeDisplayMessages(
  persisted: UIMessage[],
  chatMessages: UIMessage[],
  isLiveTurn: boolean,
  sealInterrupted = false,
): UIMessage[] {
  const shouldSeal = sealInterrupted || !isLiveTurn;

  if (!isLiveTurn) {
    return sealThread(persisted);
  }

  const byId = new Map(persisted.map((message) => [message.id, message]));
  const orderedIds = persisted.map((message) => message.id);

  for (const message of chatMessages) {
    if (byId.has(message.id)) {
      if (message.role !== "assistant") {
        byId.set(message.id, message);
      }
      continue;
    }

    const ordered = orderedIds
      .map((id) => byId.get(id))
      .filter((item): item is UIMessage => item != null);

    if (shouldSkipStaleClientAssistant(ordered, message)) {
      continue;
    }

    orderedIds.push(message.id);
    byId.set(message.id, message);
  }

  let result = orderedIds
    .map((id) => byId.get(id))
    .filter((message): message is UIMessage => message != null);

  const authoritativeAssistant = lastAssistantMessage(result);
  const liveAssistant = liveAssistantFromChat(chatMessages);

  if (authoritativeAssistant) {
    const displayAssistant = overlayLiveTextTail(
      authoritativeAssistant,
      liveAssistant,
    );
    result = upsertAssistantInMessages(result, displayAssistant);
  } else if (liveAssistant) {
    result = [...result, liveAssistant];
  }

  const deduped = dedupeConsecutiveAssistants(result);
  return shouldSeal ? finalizeInterruptedMessages(deduped) : deduped;
}

export function hasAssistantParts(message: UIMessage | undefined): boolean {
  return message?.role === "assistant" && message.parts.length > 0;
}
