import { isToolUIPart, type UIMessage } from "ai";

import { isToolPartIncomplete } from "@/lib/chat/repair-messages";

/** Cursor-style idle label while the model has not yet produced visible work. */
export const CHAT_PLANNING_LABEL = "Planning next moves";

/**
 * When the turn is live but the UI has no in-progress tool/text shimmer,
 * surface a planning label so the chat does not look frozen.
 *
 * Covers:
 * - optimistic send / agent start (last message is user, or empty assistant)
 * - after tool results settle, while the model plans the next step
 *
 * Skips when a tool is still running (tool row already shimmers).
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

  if (message.parts.length === 0) {
    return CHAT_PLANNING_LABEL;
  }

  const lastPart = message.parts[message.parts.length - 1];
  if (!isToolUIPart(lastPart) || isToolPartIncomplete(lastPart)) {
    return null;
  }

  return CHAT_PLANNING_LABEL;
}
