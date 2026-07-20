import type { ModelMessage } from "ai";

function collectToolIds(messages: ModelMessage[]): {
  callIds: Set<string>;
  resultIds: Set<string>;
} {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();

  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (part.type === "tool-call") {
        callIds.add(part.toolCallId);
      }
      if (part.type === "tool-result") {
        resultIds.add(part.toolCallId);
      }
    }
  }

  return { callIds, resultIds };
}

/**
 * Remove tool-call / tool-result pairs that were left incomplete by an
 * interrupted turn (crash, abort, finishReason=length mid-call). Without this,
 * convertToLanguageModelPrompt throws AI_MissingToolResultsError.
 */
export function sanitizeModelMessages(messages: ModelMessage[]): {
  messages: ModelMessage[];
  removedToolCallIds: string[];
} {
  const { callIds, resultIds } = collectToolIds(messages);
  const dropIds = new Set<string>();

  for (const id of callIds) {
    if (!resultIds.has(id)) {
      dropIds.add(id);
    }
  }
  for (const id of resultIds) {
    if (!callIds.has(id)) {
      dropIds.add(id);
    }
  }

  if (dropIds.size === 0) {
    return { messages, removedToolCallIds: [] };
  }

  const next: ModelMessage[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      next.push(message);
      continue;
    }

    const content = message.content.filter((part) => {
      if (part.type === "tool-call" || part.type === "tool-result") {
        return !dropIds.has(part.toolCallId);
      }
      return true;
    });

    // Drop assistant/tool messages that only had incomplete tool parts.
    if (
      (message.role === "assistant" || message.role === "tool") &&
      content.length === 0
    ) {
      continue;
    }

    next.push({ ...message, content } as ModelMessage);
  }

  return {
    messages: next,
    removedToolCallIds: [...dropIds],
  };
}
