import type { UIMessage } from "ai";

import { finalizeInterruptedMessages } from "./interrupt-assistant";
import { repairUiMessages } from "./repair-messages";

function lastMessage(messages: UIMessage[]): UIMessage | undefined {
  return messages[messages.length - 1];
}

/**
 * useChat keeps the SSE assistant id; the server persists the draft row's id after
 * the workflow completes. Skip the extra client-only assistant when persisted
 * already ended with an assistant for that turn.
 */
function shouldSkipStaleClientAssistant(
  ordered: UIMessage[],
  message: UIMessage,
): boolean {
  return (
    message.role === "assistant" && lastMessage(ordered)?.role === "assistant"
  );
}

/** Remove back-to-back assistant rows (stale SSE id + saved draft id). */
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

/**
 * Session detail can lag the in-memory useChat thread when runStatus flips
 * idle via runtime Realtime before `invalidateSessionDetail` lands — or when
 * the persisted assistant is missing the final streamed text (stale draft).
 */
export function persistedMessagesLagChat(
  persisted: UIMessage[],
  chatMessages: UIMessage[],
): boolean {
  if (chatMessages.length === 0) {
    return false;
  }

  if (chatMessages.length > persisted.length) {
    return true;
  }

  const lastPersisted = lastMessage(persisted);
  const lastChat = lastMessage(chatMessages);
  if (lastChat?.role === "assistant" && lastPersisted?.role !== "assistant") {
    return true;
  }

  if (lastChat?.role === "assistant" && lastPersisted?.role === "assistant") {
    return assistantTextLength(lastChat) > assistantTextLength(lastPersisted);
  }

  return false;
}

function assistantTextLength(message: UIMessage): number {
  let length = 0;
  for (const part of message.parts) {
    if (
      (part.type === "text" || part.type === "reasoning") &&
      typeof part.text === "string"
    ) {
      length += part.text.length;
    }
  }
  return length;
}

/**
 * Live-turn display: keep completed history from Supabase, overlay the
 * in-flight useChat thread, then fall back to the draft row when SSE has not
 * produced assistant parts yet (e.g. refresh mid-run).
 *
 * Only overlay `draft` when `allowDraftOverlay` is true (run still active).
 * Optimistic send (`awaitingRunStart`) sets isLiveTurn before runStatus flips —
 * applying a React Query–cached previous-turn draft there appends the old
 * assistant after the new user message and causes a one-frame flicker.
 *
 * When the turn is no longer live but persisted history has not caught up yet,
 * keep overlaying chatMessages so the assistant bubble does not vanish.
 *
 * Pass `sealInterrupted` while Stop is in flight (or after the turn ends) so
 * incomplete tools become "Interrupted by user" instead of stuck "Editing…".
 */
export function mergeDisplayMessages(
  persisted: UIMessage[],
  chatMessages: UIMessage[],
  draft: UIMessage | null,
  isLiveTurn: boolean,
  sealInterrupted = false,
  allowDraftOverlay = true,
): UIMessage[] {
  const treatAsLive =
    isLiveTurn || persistedMessagesLagChat(persisted, chatMessages);
  const shouldSeal = sealInterrupted || !isLiveTurn;

  if (!treatAsLive) {
    return sealThread(persisted);
  }

  const byId = new Map(persisted.map((message) => [message.id, message]));
  const orderedIds = persisted.map((message) => message.id);

  for (const message of chatMessages) {
    if (byId.has(message.id)) {
      byId.set(message.id, message);
      continue;
    }

    const lastId = orderedIds.at(-1);
    const lastMessageInThread = lastId ? byId.get(lastId) : undefined;

    if (
      message.role === "assistant" &&
      lastMessageInThread?.role === "assistant"
    ) {
      orderedIds[orderedIds.length - 1] = message.id;
      byId.set(message.id, message);
      continue;
    }

    orderedIds.push(message.id);
    byId.set(message.id, message);
  }

  let result = orderedIds
    .map((id) => byId.get(id))
    .filter((message): message is UIMessage => message != null);

  const last = result[result.length - 1];
  const liveHasAssistantParts =
    last?.role === "assistant" && last.parts.length > 0;

  /**
   * Never overlay a draft whose id is already in the thread — that is almost
   * always the previous turn's assistant re-appended after a new user message
   * when React Query still holds a stale draft row.
   */
  if (
    allowDraftOverlay &&
    !liveHasAssistantParts &&
    draft &&
    draft.parts.length > 0 &&
    !result.some((message) => message.id === draft.id)
  ) {
    if (last?.role === "assistant") {
      result = [...result.slice(0, -1), draft];
    } else if (last?.role === "user") {
      // Mid-run resume: draft follows the in-flight user turn.
      result = [...result, draft];
    }
  }

  const deduped = dedupeConsecutiveAssistants(result);
  return shouldSeal ? finalizeInterruptedMessages(deduped) : deduped;
}

export function hasAssistantParts(message: UIMessage | undefined): boolean {
  return message?.role === "assistant" && message.parts.length > 0;
}
