import type { UIMessage } from "ai";

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
    return persisted;
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
    if (!seen.has(message.id)) {
      ordered.push(message);
      seen.add(message.id);
    }
  }

  return ordered;
}

/**
 * Live-turn display: keep completed history from session.json, overlay the
 * in-flight useChat thread, then fall back to draft.json when SSE has not
 * produced assistant parts yet (e.g. refresh mid-run).
 */
export function mergeDisplayMessages(
  persisted: UIMessage[],
  chatMessages: UIMessage[],
  draft: UIMessage | null,
  isLiveTurn: boolean,
): UIMessage[] {
  if (!isLiveTurn) {
    return persisted;
  }

  const byId = new Map(persisted.map((message) => [message.id, message]));
  const orderedIds = persisted.map((message) => message.id);

  for (const message of chatMessages) {
    if (byId.has(message.id)) {
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

  return result;
}

export function hasAssistantParts(message: UIMessage | undefined): boolean {
  return message?.role === "assistant" && message.parts.length > 0;
}
