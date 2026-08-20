import { isToolUIPart, type UIMessage } from "ai";

function textOf(message: UIMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<UIMessage["parts"][number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function isToolPartIncomplete(part: UIMessage["parts"][number]): boolean {
  return (
    isToolUIPart(part) &&
    (part.state === "input-streaming" || part.state === "input-available")
  );
}

/** True when a message has nothing the model can use. */
export function isEmptyUiMessage(message: UIMessage): boolean {
  return !message.parts.some((part) => {
    if (part.type === "text" || part.type === "reasoning") {
      return part.text.trim().length > 0;
    }
    if (part.type === "file") {
      return true;
    }
    if (isToolUIPart(part) && !isToolPartIncomplete(part)) {
      return true;
    }
    return false;
  });
}

/**
 * Failed / aborted turns often persist an assistant that only has
 * in-flight tool calls. Drop it so the next user turn is not blocked.
 */
function isInterruptedAssistant(message: UIMessage): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const parts = message.parts.filter((part) => part.type !== "step-start");
  if (parts.length === 0) {
    return true;
  }
  return parts.every(
    (part) =>
      isToolPartIncomplete(part) ||
      ((part.type === "text" || part.type === "reasoning") &&
        part.text.trim().length === 0),
  );
}

function mergeUserUiMessages(earlier: UIMessage, later: UIMessage): UIMessage {
  const earlierText = textOf(earlier);
  const laterText = textOf(later);
  if (earlierText === laterText || earlierText.length === 0) {
    return later;
  }
  if (laterText.length === 0) {
    return { ...later, parts: earlier.parts };
  }

  const nonText = [...earlier.parts, ...later.parts].filter(
    (part) => part.type !== "text",
  );
  return {
    ...later,
    parts: [{ type: "text", text: `${earlierText}\n\n${laterText}` }, ...nonText],
  };
}

/**
 * Fix conversation threads left inconsistent by a crashed or failed turn:
 * consecutive user messages, empty / interrupted assistant rows, and
 * leading non-user messages. The repaired list is safe to persist and to
 * pass through convertToModelMessages.
 */
export function repairUiMessages(messages: UIMessage[]): UIMessage[] {
  const repaired: UIMessage[] = [];

  for (const message of messages) {
    if (isEmptyUiMessage(message) || isInterruptedAssistant(message)) {
      continue;
    }

    if (repaired.length === 0 && message.role !== "user") {
      continue;
    }

    const previous = repaired[repaired.length - 1];

    if (previous?.role === "user" && message.role === "user") {
      repaired[repaired.length - 1] = mergeUserUiMessages(previous, message);
      continue;
    }

    if (previous?.role === "assistant" && message.role === "assistant") {
      repaired[repaired.length - 1] =
        message.parts.length >= previous.parts.length ? message : previous;
      continue;
    }

    repaired.push(message);
  }

  if (repaired.length > 0) {
    return repaired;
  }

  const lastUser = [...messages]
    .reverse()
    .find((message) => message.role === "user" && !isEmptyUiMessage(message));
  return lastUser ? [lastUser] : messages;
}
