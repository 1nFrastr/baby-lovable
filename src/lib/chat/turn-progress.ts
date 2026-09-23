import { isToolUIPart, type ModelMessage, type UIMessage } from "ai";

import {
  assistantHasPersistedContent,
  finalizeInterruptedAssistant,
} from "./interrupt-assistant";
import { truncateReasoningText } from "./reasoning-text";

export interface OrderedToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export type ToolCompletion =
  | {
      success: true;
      output: unknown;
    }
  | {
      success: false;
      errorText: string;
    };

export interface ToolProgressEvent {
  calls: OrderedToolCall[];
  completedCallId?: string;
  completion?: ToolCompletion;
}

export interface RecordedAgentStep {
  content: Array<{
    type: string;
    text?: string;
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
  }>;
  reasoning?: Array<{ text?: string }>;
  text?: string;
}

export function createTurnAssistantMessage(id: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [],
  };
}

function isTerminalToolState(state: string): boolean {
  return (
    state === "output-available" ||
    state === "output-error" ||
    state === "output-denied"
  );
}

function isTerminalToolPart(
  part: UIMessage["parts"][number],
): boolean {
  return (
    isToolUIPart(part) &&
    "state" in part &&
    isTerminalToolState(String(part.state))
  );
}

function toolPartForCall(
  call: OrderedToolCall,
  completion?: ToolCompletion,
): UIMessage["parts"][number] {
  if (!completion) {
    return {
      type: `tool-${call.toolName}` as `tool-${string}`,
      toolCallId: call.toolCallId,
      state: "input-available",
      input: call.input,
    };
  }

  if (completion.success) {
    return {
      type: `tool-${call.toolName}` as `tool-${string}`,
      toolCallId: call.toolCallId,
      state: "output-available",
      input: call.input,
      output: completion.output,
    };
  }

  return {
    type: `tool-${call.toolName}` as `tool-${string}`,
    toolCallId: call.toolCallId,
    state: "output-error",
    input: call.input,
    errorText: completion.errorText,
  };
}

function replaceAssistant(
  messages: UIMessage[],
  assistant: UIMessage,
): UIMessage[] {
  const index = messages.findIndex((message) => message.id === assistant.id);
  if (index < 0) {
    throw new Error(
      `Active assistant message not found: ${assistant.id}`,
    );
  }
  if (messages[index]?.role !== "assistant") {
    throw new Error(`Message ${assistant.id} is not an assistant message`);
  }

  return [
    ...messages.slice(0, index),
    assistant,
    ...messages.slice(index + 1),
  ];
}

export function getTurnAssistant(
  messages: UIMessage[],
  assistantMessageId: string,
): UIMessage {
  const assistant = messages.find(
    (message) =>
      message.id === assistantMessageId && message.role === "assistant",
  );
  if (!assistant) {
    throw new Error(
      `Active assistant message not found: ${assistantMessageId}`,
    );
  }
  return assistant;
}

/**
 * Materialize the ordered call batch before execution and monotonically
 * upgrade one completed call in place. Replaying the same event is idempotent.
 */
export function applyToolProgress(
  messages: UIMessage[],
  assistantMessageId: string,
  event: ToolProgressEvent,
): UIMessage[] {
  const assistant = getTurnAssistant(messages, assistantMessageId);
  const parts = [...assistant.parts];
  const existingByCallId = new Map<string, number>();

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (isToolUIPart(part)) {
      existingByCallId.set(part.toolCallId, index);
    }
  }

  const batchIsNew = event.calls.every(
    (call) => !existingByCallId.has(call.toolCallId),
  );
  if (batchIsNew && event.calls.length > 0) {
    parts.push({ type: "step-start" });
    for (const call of event.calls) {
      existingByCallId.set(call.toolCallId, parts.length);
      parts.push(toolPartForCall(call));
    }
  } else {
    for (const call of event.calls) {
      if (existingByCallId.has(call.toolCallId)) {
        continue;
      }
      existingByCallId.set(call.toolCallId, parts.length);
      parts.push(toolPartForCall(call));
    }
  }

  if (event.completedCallId && event.completion) {
    const call = event.calls.find(
      (candidate) => candidate.toolCallId === event.completedCallId,
    );
    const index = existingByCallId.get(event.completedCallId);
    if (!call || index == null) {
      throw new Error(
        `Completed tool call missing from ordered batch: ${event.completedCallId}`,
      );
    }

    const existing = parts[index]!;
    if (!isTerminalToolPart(existing)) {
      parts[index] = toolPartForCall(call, event.completion);
    }
  }

  return replaceAssistant(messages, {
    ...assistant,
    parts,
  });
}

function toolCompletionsById(
  message: UIMessage,
): Map<string, UIMessage["parts"][number]> {
  const terminal = new Map<string, UIMessage["parts"][number]>();
  for (const part of message.parts) {
    if (isToolUIPart(part) && isTerminalToolPart(part)) {
      terminal.set(part.toolCallId, part);
    }
  }
  return terminal;
}

/**
 * Replace the active assistant with a cumulative, correctly ordered step
 * snapshot. Existing terminal tools can only remain terminal.
 */
export function applyAssistantSnapshot(
  messages: UIMessage[],
  snapshot: UIMessage,
): UIMessage[] {
  const existing = getTurnAssistant(messages, snapshot.id);
  const terminal = toolCompletionsById(existing);
  const seenTools = new Set<string>();
  const parts = snapshot.parts.map((part) => {
    if (!isToolUIPart(part)) {
      return part;
    }
    seenTools.add(part.toolCallId);
    const priorTerminal = terminal.get(part.toolCallId);
    return priorTerminal && !isTerminalToolPart(part)
      ? priorTerminal
      : part;
  });

  for (const toolCallId of terminal.keys()) {
    if (!seenTools.has(toolCallId)) {
      throw new Error(
        `Newer assistant snapshot omitted completed tool ${toolCallId}`,
      );
    }
  }

  return replaceAssistant(messages, {
    ...snapshot,
    role: "assistant",
    parts,
  });
}

export function assistantTextContent(message: UIMessage): string {
  return message.parts
    .map((part) => (part.type === "text" && "text" in part ? part.text : ""))
    .join("");
}

function textOfModelMessage(message: ModelMessage): string {
  if (message.role !== "assistant") {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .map((part) =>
      part.type === "text" && "text" in part ? part.text : "",
    )
    .join("");
}

/**
 * The workflow return's last assistant message is the closing text.
 * Step callbacks can record only a prefix of that close. Put the longer
 * closing text on the last text part. A shorter model close is left alone:
 * tool-call steps keep narration that the model transcript drops.
 */
export function applyClosingModelText(
  assistant: UIMessage,
  modelMessages: readonly ModelMessage[],
): UIMessage {
  const closing = [...modelMessages]
    .reverse()
    .find((message) => message.role === "assistant");
  const finalText = closing ? textOfModelMessage(closing) : "";
  if (!finalText || assistantTextContent(assistant).includes(finalText)) {
    return assistant;
  }

  let lastTextIndex = -1;
  for (let index = assistant.parts.length - 1; index >= 0; index -= 1) {
    const part = assistant.parts[index];
    if (part?.type === "text" && "text" in part && part.text) {
      lastTextIndex = index;
      break;
    }
  }

  if (lastTextIndex < 0) {
    return {
      ...assistant,
      parts: [...assistant.parts, { type: "text", text: finalText, state: "done" }],
    };
  }

  const current = assistant.parts[lastTextIndex];
  if (!current || current.type !== "text" || finalText.length <= current.text.length) {
    return assistant;
  }

  const parts = [...assistant.parts];
  parts[lastTextIndex] = { ...current, text: finalText, state: "done" };
  return { ...assistant, parts };
}

/**
 * Terminal write for a completed turn. An older checkpoint cannot replace
 * the stored assistant, and a shorter body cannot replace a longer one.
 */
export function completedAssistantWrite(input: {
  messages: UIMessage[];
  snapshot: UIMessage;
  checkpoint: number;
  storedCheckpoint: number;
}): { message: UIMessage | null; checkpoint: number } {
  const stored = getTurnAssistant(input.messages, input.snapshot.id);
  const checkpoint = Math.max(input.checkpoint, input.storedCheckpoint);

  if (input.checkpoint < input.storedCheckpoint) {
    return {
      message: assistantHasPersistedContent(stored) ? stored : null,
      checkpoint: input.storedCheckpoint,
    };
  }

  if (!assistantHasPersistedContent(input.snapshot)) {
    return {
      message: assistantHasPersistedContent(stored) ? stored : null,
      checkpoint,
    };
  }

  const merged = getTurnAssistant(
    applyAssistantSnapshot(input.messages, input.snapshot),
    input.snapshot.id,
  );
  if (
    assistantTextContent(stored).length > assistantTextContent(merged).length
  ) {
    return { message: stored, checkpoint };
  }

  return { message: merged, checkpoint };
}

/**
 * Reasoning deltas are often one token per part. Concatenate them into a
 * single paragraph; do not insert markdown paragraph breaks between tokens.
 * Do not insert a space between a high+low surrogate pair (one emoji split
 * across deltas) — that would leave unpaired code units for jsonb sanitize.
 */
export function joinReasoningText(
  parts: Array<{ text?: string } | string>,
): string {
  return parts.reduce<string>((joined, part) => {
    const next = typeof part === "string" ? part : (part.text ?? "");
    if (!next) {
      return joined;
    }
    if (!joined) {
      return next;
    }
    const glueSurrogatePair =
      isHighSurrogate(joined.charCodeAt(joined.length - 1)) &&
      isLowSurrogate(next.charCodeAt(0));
    const needsSpace =
      !glueSurrogatePair && !/\s$/.test(joined) && !/^\s/.test(next);
    return needsSpace ? `${joined} ${next}` : `${joined}${next}`;
  }, "");
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function appendRecordedStep(
  assistant: UIMessage,
  step: RecordedAgentStep,
  completions: ReadonlyMap<string, ToolCompletion>,
): UIMessage {
  if (assistant.role !== "assistant") {
    throw new Error("Turn recorder requires an assistant message");
  }

  const stepParts: UIMessage["parts"] = [{ type: "step-start" }];
  const reasoningText = truncateReasoningText(
    joinReasoningText(step.reasoning ?? []),
  );
  if (reasoningText) {
    stepParts.push({
      type: "reasoning",
      text: reasoningText,
      state: "done",
    });
  }

  let sawText = false;
  for (const part of step.content) {
    if (part.type === "text" && part.text) {
      sawText = true;
      stepParts.push({
        type: "text",
        text: part.text,
        state: "done",
      });
      continue;
    }

    if (
      part.type === "tool-call" &&
      part.toolCallId &&
      part.toolName
    ) {
      stepParts.push(
        toolPartForCall(
          {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          },
          completions.get(part.toolCallId),
        ),
      );
    }
  }

  if (!sawText && step.text) {
    stepParts.push({ type: "text", text: step.text, state: "done" });
  }

  return {
    ...assistant,
    parts: [...assistant.parts, ...stepParts],
  };
}

/**
 * Stop may have a same-id client snapshot that is ahead by a partial token or
 * currently running tool. Use its exact order, while preserving every terminal
 * tool already committed by the server.
 */
export function finalizeTurnForCancellation(
  authoritative: UIMessage,
  clientSnapshot?: UIMessage | null,
): UIMessage {
  let candidate = authoritative;
  if (
    clientSnapshot?.role === "assistant" &&
    clientSnapshot.id === authoritative.id &&
    clientSnapshot.parts.length >= authoritative.parts.length
  ) {
    const terminal = toolCompletionsById(authoritative);
    const parts = clientSnapshot.parts.map((part) => {
      if (!isToolUIPart(part)) {
        return part;
      }
      return terminal.get(part.toolCallId) ?? part;
    });
    candidate = { ...clientSnapshot, parts };
  }

  return finalizeInterruptedAssistant(candidate);
}
