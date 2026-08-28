import { isToolUIPart, type UIMessage } from "ai";

import { isToolPartIncomplete } from "./repair-messages";

/** Stable assistant placeholder written at turn start. */
export function createAssistantPlaceholder(assistantId: string): UIMessage {
  return {
    id: assistantId,
    role: "assistant",
    parts: [],
  };
}

function isToolPartComplete(part: UIMessage["parts"][number]): boolean {
  return isToolUIPart(part) && !isToolPartIncomplete(part);
}

function textPartsFrom(message: UIMessage): UIMessage["parts"] {
  return message.parts.filter(
    (part) => part.type === "text" || part.type === "reasoning",
  );
}

function nonTextPartsFrom(message: UIMessage): UIMessage["parts"] {
  return message.parts.filter(
    (part) => part.type !== "text" && part.type !== "reasoning",
  );
}

function textLength(parts: UIMessage["parts"]): number {
  let length = 0;
  for (const part of parts) {
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
 * Merge assistant parts with monotonic tool state: completed tools on the
 * authoritative message are never downgraded by a fresher incomplete stream.
 */
export function mergeAssistantMonotonically(
  authoritative: UIMessage,
  incoming: UIMessage,
): UIMessage {
  if (authoritative.role !== "assistant" || incoming.role !== "assistant") {
    return authoritative;
  }

  const completedById = new Map<string, UIMessage["parts"][number]>();
  for (const part of authoritative.parts) {
    if (isToolUIPart(part) && part.toolCallId && isToolPartComplete(part)) {
      completedById.set(part.toolCallId, part);
    }
  }

  const authText = textPartsFrom(authoritative);
  const incomingText = textPartsFrom(incoming);
  const textParts =
    textLength(incomingText) > textLength(authText) ? incomingText : authText;

  const finalParts: UIMessage["parts"] = [];
  let usedText = false;

  for (const part of incoming.parts) {
    if (part.type === "text" || part.type === "reasoning") {
      if (!usedText && textParts.length > 0) {
        finalParts.push(...textParts);
        usedText = true;
      }
      continue;
    }

    if (isToolUIPart(part) && part.toolCallId) {
      finalParts.push(completedById.get(part.toolCallId) ?? part);
      continue;
    }

    finalParts.push(part);
  }

  if (!usedText && textParts.length > 0) {
    finalParts.unshift(...textParts);
  }

  for (const part of authoritative.parts) {
    if (
      isToolUIPart(part) &&
      part.toolCallId &&
      isToolPartComplete(part) &&
      !finalParts.some(
        (candidate) =>
          isToolUIPart(candidate) && candidate.toolCallId === part.toolCallId,
      )
    ) {
      finalParts.push(part);
    }
  }

  return {
    ...authoritative,
    parts: finalParts,
  };
}

/**
 * Overlay only unpersisted streaming text from the live SSE assistant onto the
 * authoritative assistant. Tool parts always come from the authoritative copy.
 */
export function overlayLiveTextTail(
  authoritative: UIMessage,
  live: UIMessage | null | undefined,
): UIMessage {
  if (!live || live.role !== "assistant" || authoritative.role !== "assistant") {
    return authoritative;
  }

  const liveText = textPartsFrom(live);
  const authText = textPartsFrom(authoritative);

  if (liveText.length === 0) {
    return authoritative;
  }

  if (textLength(liveText) <= textLength(authText)) {
    return authoritative;
  }

  return {
    ...authoritative,
    parts: [...liveText, ...nonTextPartsFrom(authoritative)],
  };
}

/** Replace or append the assistant message in a thread by stable id. */
export function upsertAssistantInMessages(
  messages: UIMessage[],
  assistant: UIMessage,
): UIMessage[] {
  const index = messages.findIndex((message) => message.id === assistant.id);
  if (index === -1) {
    const last = messages[messages.length - 1];
    if (last?.role === "assistant") {
      return [...messages.slice(0, -1), assistant];
    }
    return [...messages, assistant];
  }

  return messages.map((message, messageIndex) =>
    messageIndex === index ? assistant : message,
  );
}

/** Last assistant row in the thread, if any. */
export function lastAssistantMessage(
  messages: UIMessage[],
): UIMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      return messages[index];
    }
  }
  return undefined;
}

/** True when a new tool part reached a terminal state since the last snapshot. */
export function hasNewlyCompletedTool(
  previous: UIMessage,
  next: UIMessage,
): boolean {
  const previousComplete = new Set(
    previous.parts
      .filter(isToolPartComplete)
      .filter(isToolUIPart)
      .map((part) => part.toolCallId),
  );

  return next.parts.some(
    (part) =>
      isToolUIPart(part) &&
      isToolPartComplete(part) &&
      !previousComplete.has(part.toolCallId),
  );
}
