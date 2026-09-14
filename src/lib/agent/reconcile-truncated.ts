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

function extractStepText(step: StepWithContent): string {
  if (typeof step.text === "string" && step.text.length > 0) {
    return step.text;
  }
  if (!Array.isArray(step.content)) {
    return "";
  }
  return step.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        part.type === "text" && typeof part.text === "string" && part.text.length > 0,
    )
    .map((part) => part.text)
    .join("");
}

function textAlreadyPresent(existing: string, stepText: string): boolean {
  return (
    existing === stepText ||
    (existing.length > 40 && stepText.startsWith(existing.slice(0, 40))) ||
    (stepText.length > 40 && existing.startsWith(stepText.slice(0, 40)))
  );
}

/**
 * WorkflowAgent stops on finishReason=length without pushing the truncated
 * assistant turn into conversationPrompt — so result.messages omit text that
 * was already streamed to the UI. Re-attach that text so auto-continue and
 * session persistence see the cut-off content.
 *
 * Only text is reattached. Last-step tool-calls already live in messages
 * (call + result). Copying them again creates a duplicate unpaired call;
 * auto-continue then appends a user hint and convertToLanguageModelPrompt
 * throws AI_MissingToolResultsError.
 */
export function reconcileMessagesWithLastStep(
  messages: ModelMessage[],
  steps: StepWithContent[],
): ModelMessage[] {
  const last = steps.at(-1);
  if (!last) {
    return messages;
  }

  const stepText = extractStepText(last);
  if (!stepText) {
    return messages;
  }

  const lastMessage = messages.at(-1);
  if (lastMessage?.role === "assistant") {
    const existing = extractAssistantText(lastMessage);
    if (textAlreadyPresent(existing, stepText)) {
      return messages;
    }
  }

  return [
    ...messages,
    { role: "assistant", content: [{ type: "text", text: stepText }] },
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
