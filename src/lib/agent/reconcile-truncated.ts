import type { ModelMessage } from "ai";

/** Minimal step shape we need from WorkflowAgent.stream(). */
export interface StepWithContent {
  finishReason?: string;
  text?: string;
  content?: Array<{ type: string; text?: string; toolCallId?: string; toolName?: string; input?: unknown }>;
  toolCalls?: Array<{
    toolCallId?: string;
    toolName: string;
    input?: unknown;
  }>;
  usage?: { outputTokens?: number };
}

function extractAssistantText(message: ModelMessage): string {
  if (message.role !== "assistant") {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

function buildPartsFromStep(step: StepWithContent): Array<
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
> {
  const parts: Array<
    | { type: "text"; text: string }
    | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  > = [];

  if (typeof step.text === "string" && step.text.length > 0) {
    parts.push({ type: "text", text: step.text });
  }

  for (const tc of step.toolCalls ?? []) {
    if (tc.toolCallId && tc.toolName) {
      parts.push({
        type: "tool-call",
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        input: tc.input ?? {},
      });
    }
  }

  if (parts.length === 0 && Array.isArray(step.content)) {
    for (const part of step.content) {
      if (part.type === "text" && typeof part.text === "string" && part.text) {
        parts.push({ type: "text", text: part.text });
      }
      if (
        part.type === "tool-call" &&
        part.toolCallId &&
        part.toolName
      ) {
        parts.push({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input ?? {},
        });
      }
    }
  }

  return parts;
}

/**
 * WorkflowAgent stops on finishReason=length without pushing the truncated
 * assistant turn into conversationPrompt — so result.messages omit text that
 * was already streamed to the UI. Re-attach the last step so auto-continue
 * and session persistence see the cut-off content.
 */
export function reconcileMessagesWithLastStep(
  messages: ModelMessage[],
  steps: StepWithContent[],
): ModelMessage[] {
  const last = steps.at(-1);
  if (!last) {
    return messages;
  }

  const parts = buildPartsFromStep(last);
  if (parts.length === 0) {
    return messages;
  }

  const stepText = parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");

  const lastMessage = messages.at(-1);
  if (lastMessage?.role === "assistant" && stepText) {
    const existing = extractAssistantText(lastMessage);
    // Already reconciled / included (prefix match handles minor streaming drift).
    if (
      existing === stepText ||
      (existing.length > 40 && stepText.startsWith(existing.slice(0, 40))) ||
      (stepText.length > 40 && existing.startsWith(stepText.slice(0, 40)))
    ) {
      return messages;
    }
  }

  return [
    ...messages,
    { role: "assistant", content: parts } as ModelMessage,
  ];
}

/**
 * True when the pass was cut by the output token limit — including providers
 * that sometimes report "other"/"stop" while usage sits at the ceiling.
 */
export function isOutputLengthFinish(
  finishReason: string,
  options?: {
    lastStep?: StepWithContent;
    maxOutputTokens?: number;
  },
): boolean {
  if (finishReason === "length" || options?.lastStep?.finishReason === "length") {
    return true;
  }

  const max = options?.maxOutputTokens;
  const out = options?.lastStep?.usage?.outputTokens;
  if (max != null && max > 0 && out != null && out >= Math.floor(max * 0.95)) {
    return true;
  }

  return false;
}
