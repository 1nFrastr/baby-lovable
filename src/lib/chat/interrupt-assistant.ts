import { isToolUIPart, type UIMessage } from "ai";

import { isEmptyUiMessage, isToolPartIncomplete } from "./repair-messages";

export const INTERRUPTED_BY_USER = "Interrupted by user";

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

export function assistantHasPersistedContent(message: UIMessage): boolean {
  return message.role === "assistant" && !isEmptyUiMessage(message);
}
