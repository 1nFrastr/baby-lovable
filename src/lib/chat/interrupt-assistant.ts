import { isToolUIPart, type UIMessage } from "ai";

import { isEmptyUiMessage, isToolPartIncomplete } from "./repair-messages";

export const INTERRUPTED_BY_USER = "Interrupted by user";

function textContentLength(message: UIMessage): number {
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

function finalizePart(
  part: UIMessage["parts"][number],
): UIMessage["parts"][number] {
  if (
    (part.type === "text" || part.type === "reasoning") &&
    "state" in part &&
    part.state === "streaming"
  ) {
    return { ...part, state: "done" };
  }

  if (!isToolUIPart(part) || !isToolPartIncomplete(part)) {
    return part;
  }

  if (part.type === "dynamic-tool") {
    return {
      type: "dynamic-tool",
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      title: part.title,
      state: "output-error",
      input: part.input,
      errorText: INTERRUPTED_BY_USER,
    };
  }

  return {
    type: part.type,
    toolCallId: part.toolCallId,
    title: part.title,
    state: "output-error",
    input: "input" in part ? part.input : undefined,
    errorText: INTERRUPTED_BY_USER,
  };
}

export function assistantHasInFlightParts(message: UIMessage): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  return message.parts.some((part) => {
    if (
      (part.type === "text" || part.type === "reasoning") &&
      "state" in part &&
      part.state === "streaming"
    ) {
      return true;
    }
    return isToolPartIncomplete(part);
  });
}

/**
 * Freeze an in-flight assistant so the UI does not keep showing running tools
 * after the user stops the turn. Incomplete tool parts become output-error.
 */
export function finalizeInterruptedAssistant(message: UIMessage): UIMessage {
  if (message.role !== "assistant" || !assistantHasInFlightParts(message)) {
    return message;
  }

  return {
    ...message,
    parts: message.parts.map(finalizePart),
  };
}

/** Close out every interrupted assistant in a thread (display + next-turn prompt). */
export function finalizeInterruptedMessages(
  messages: UIMessage[],
): UIMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    const finalized = finalizeInterruptedAssistant(message);
    if (finalized !== message) {
      changed = true;
    }
    return finalized;
  });
  return changed ? next : messages;
}

/**
 * Prefer the richer in-flight snapshot when draft materialization lagged the
 * SSE / model thread (common when Stop hits mid-tool, or when the final
 * summary text arrived on the HTTP stream after the last draft write).
 *
 * Text length is weighted highest so a lagging draft with the same tool
 * parts cannot overwrite a complete closing summary.
 */
export function pickCancelledAssistantSnapshot(
  candidates: Array<UIMessage | null | undefined>,
): UIMessage | null {
  let best: UIMessage | null = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    if (!candidate || candidate.role !== "assistant") {
      continue;
    }
    const finalized = finalizeInterruptedAssistant(candidate);
    if (!assistantHasPersistedContent(finalized)) {
      continue;
    }
    const score =
      textContentLength(finalized) * 1000 +
      finalized.parts.length * 100 +
      finalized.parts.filter((part) => isToolUIPart(part)).length * 10 +
      (assistantHasInFlightParts(candidate) ? 1 : 0);
    if (score > bestScore) {
      best = finalized;
      bestScore = score;
    }
  }

  return best;
}

export function assistantHasPersistedContent(message: UIMessage): boolean {
  return message.role === "assistant" && !isEmptyUiMessage(message);
}
