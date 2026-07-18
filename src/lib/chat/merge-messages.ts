import type { UIMessage } from "ai";

function lastMessage(messages: UIMessage[]): UIMessage | undefined {
  return messages[messages.length - 1];
}

/**
 * useChat keeps the SSE assistant id; the server persists draft.json's id after
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
    return dedupeConsecutiveAssistants(persisted);
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

  return dedupeConsecutiveAssistants(ordered);
}

/**
 * Session detail can lag the in-memory useChat thread when runStatus flips
 * idle via runtime SSE before `invalidateSessionDetail` lands.
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
  return lastChat?.role === "assistant" && lastPersisted?.role !== "assistant";
}

/**
 * Live-turn display: keep completed history from session.json, overlay the
 * in-flight useChat thread, then fall back to draft.json when SSE has not
 * produced assistant parts yet (e.g. refresh mid-run).
 *
 * When the turn is no longer live but persisted history has not caught up yet,
 * keep overlaying chatMessages so the assistant bubble does not vanish.
 */
export function mergeDisplayMessages(
  persisted: UIMessage[],
  chatMessages: UIMessage[],
  draft: UIMessage | null,
  isLiveTurn: boolean,
): UIMessage[] {
  const treatAsLive =
    isLiveTurn || persistedMessagesLagChat(persisted, chatMessages);

  if (!treatAsLive) {
    return dedupeConsecutiveAssistants(persisted);
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

  if (!liveHasAssistantParts && draft && draft.parts.length > 0) {
    if (last?.role === "assistant") {
      result = [...result.slice(0, -1), draft];
    } else {
      result = [...result, draft];
    }
  }

  return dedupeConsecutiveAssistants(result);
}

export function hasAssistantParts(message: UIMessage | undefined): boolean {
  return message?.role === "assistant" && message.parts.length > 0;
}
