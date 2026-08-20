import type { ModelMessage } from "ai";

const TOOL_RESULT_OUTPUT_TYPES = new Set([
  "text",
  "json",
  "error-text",
  "error-json",
  "execution-denied",
  "content",
]);

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

/** Coerce compact stubs / raw payloads into a schema-valid ToolResultOutput. */
export function toToolResultOutput(
  output: unknown,
  fallbackText?: string,
): { type: "text" | "json"; value: unknown } {
  if (output != null && typeof output === "object" && !Array.isArray(output)) {
    const rec = output as Record<string, unknown>;
    if (typeof rec.type === "string" && TOOL_RESULT_OUTPUT_TYPES.has(rec.type)) {
      return output as { type: "text" | "json"; value: unknown };
    }
  }
  if (typeof output === "string") {
    return { type: "text", value: output };
  }
  if (output == null && fallbackText) {
    return { type: "text", value: fallbackText };
  }
  return { type: "json", value: output ?? null };
}

function modelText(message: ModelMessage): string {
  if (typeof message.content === "string") {
    return message.content.trim();
  }
  return message.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function isEmptyModelMessage(message: ModelMessage): boolean {
  if (typeof message.content === "string") {
    return message.content.trim().length === 0;
  }
  return message.content.length === 0;
}

function mergeUserModelMessages(
  earlier: ModelMessage,
  later: ModelMessage,
): ModelMessage {
  const earlierText = modelText(earlier);
  const laterText = modelText(later);
  if (earlierText === laterText || earlierText.length === 0) {
    return later;
  }
  if (laterText.length === 0) {
    return earlier;
  }
  if (typeof earlier.content === "string" && typeof later.content === "string") {
    return { role: "user", content: `${earlierText}\n\n${laterText}` };
  }

  const partsOf = (message: ModelMessage) =>
    typeof message.content === "string"
      ? message.content.trim()
        ? [{ type: "text" as const, text: message.content }]
        : []
      : message.content;

  return {
    role: "user",
    content: [...partsOf(earlier), ...partsOf(later)],
  } as ModelMessage;
}

function stripUnpairedTools(
  messages: ModelMessage[],
  dropIds: Set<string>,
): ModelMessage[] {
  if (dropIds.size === 0) {
    return messages;
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

    if (
      (message.role === "assistant" || message.role === "tool") &&
      content.length === 0
    ) {
      continue;
    }

    next.push({ ...message, content } as ModelMessage);
  }
  return next;
}

function normalizeToolOutputs(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) {
      return message;
    }

    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result") {
        return part;
      }
      const output = toToolResultOutput(part.output);
      if (output === part.output) {
        return part;
      }
      changed = true;
      return { ...part, output: output as typeof part.output };
    });

    return changed ? ({ ...message, content } as ModelMessage) : message;
  });
}

/**
 * Drop empty rows, leading non-user leftovers, and consecutive user messages
 * left behind when a turn crashed before an assistant reply was saved.
 */
function repairModelMessageOrder(messages: ModelMessage[]): ModelMessage[] {
  const hasUser = messages.some(
    (message) => message.role === "user" && !isEmptyModelMessage(message),
  );
  const repaired: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role === "system" || isEmptyModelMessage(message)) {
      continue;
    }

    if (
      hasUser &&
      repaired.length === 0 &&
      message.role !== "user"
    ) {
      continue;
    }

    const previous = repaired[repaired.length - 1];
    if (previous?.role === "user" && message.role === "user") {
      repaired[repaired.length - 1] = mergeUserModelMessages(previous, message);
      continue;
    }

    repaired.push(message);
  }

  return repaired;
}

/**
 * Remove tool-call / tool-result pairs that were left incomplete by an
 * interrupted turn (crash, abort, finishReason=length mid-call), then fix
 * message order so convertToLanguageModelPrompt does not throw
 * AI_MissingToolResultsError or AI_InvalidPromptError.
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

  const stripped = stripUnpairedTools(messages, dropIds);
  const normalized = normalizeToolOutputs(stripped);
  const repaired = repairModelMessageOrder(normalized);

  return {
    messages: repaired,
    removedToolCallIds: [...dropIds],
  };
}
