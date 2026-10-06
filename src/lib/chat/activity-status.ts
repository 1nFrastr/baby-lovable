import { isToolUIPart, type UIMessage } from "ai";

import { isToolPartIncomplete } from "@/lib/chat/repair-messages";

/** Cursor-style idle label while the model has not yet produced visible work. */
export const CHAT_PLANNING_LABEL = "Planning next moves";

function lastVisibleActivityPart(
  message: UIMessage,
): UIMessage["parts"][number] | undefined {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (!part) {
      continue;
    }
    if (isToolUIPart(part) || part.type === "reasoning") {
      return part;
    }
    if (part.type === "text" && part.text.trim().length > 0) {
      return part;
    }
  }
  return undefined;
}

/**
 * When the turn is live but the UI has no in-progress tool/text shimmer,
 * surface a planning label so the chat does not look frozen.
 *
 * Covers:
 * - optimistic send / agent start (last message is user, or empty assistant)
 * - after tool results settle, while the model plans the next step
 * - stream placeholders such as `step-start` before Thinking/tools exist
 *
 * Skips only when a successor row is already visible (tool shimmer,
 * Thinking, or assistant text).
 */
export function resolveChatActivityLabel(options: {
  live: boolean;
  lastMessage: UIMessage | undefined;
}): string | null {
  if (!options.live) {
    return null;
  }

  const message = options.lastMessage;
  if (!message || message.role === "user") {
    return CHAT_PLANNING_LABEL;
  }

  if (message.role !== "assistant") {
    return null;
  }

  const lastVisible = lastVisibleActivityPart(message);
  if (!lastVisible) {
    return CHAT_PLANNING_LABEL;
  }

  if (isToolUIPart(lastVisible) && !isToolPartIncomplete(lastVisible)) {
    return CHAT_PLANNING_LABEL;
  }

  return null;
}
