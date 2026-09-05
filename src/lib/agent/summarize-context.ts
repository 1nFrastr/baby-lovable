import {
  generateId,
  generateText,
  getToolName,
  isToolUIPart,
  type UIMessage,
} from "ai";

import { CONTEXT_KEEP_RECENT_MESSAGES } from "@/lib/agent/context-compact";
import {
  CONTEXT_SUMMARY_HEADING,
  CONTEXT_SUMMARY_KIND,
  isContextSummaryMessage,
  type ContextSummaryMetadata,
} from "@/lib/chat/context-summary";

export {
  CONTEXT_SUMMARY_HEADING,
  CONTEXT_SUMMARY_KIND,
  isContextSummaryMessage,
  type ContextSummaryMetadata,
} from "@/lib/chat/context-summary";

const TRANSCRIPT_MAX_CHARS = 60_000;
const TEXT_SNIPPET_MAX = 400;
const MIN_MESSAGES = 2;
const MIN_TOKENS_TO_SUMMARIZE = 1_500;

export type GenerateContextSummary = (input: {
  transcript: string;
  guidance?: string;
}) => Promise<string>;

export interface SummarizeMessagesResult {
  messages: UIMessage[];
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  droppedMessageCount: number;
}

export class SummarizeContextError extends Error {
  constructor(
    message: string,
    readonly code: "not_enough_history",
  ) {
    super(message);
    this.name = "SummarizeContextError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function estimateUiTokens(messages: UIMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

function textOf(message: UIMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<UIMessage["parts"][number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n");
}

function readPath(input: unknown): string | undefined {
  if (!isRecord(input) || typeof input.path !== "string") {
    return undefined;
  }
  const path = input.path.trim();
  return path.length > 0 ? path : undefined;
}

function snippet(value: string, max = TEXT_SNIPPET_MAX): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}…`;
}

/** Compact transcript for the summarizer — text + tool names, not payloads. */
export function buildConversationTranscript(messages: UIMessage[]): string {
  const lines: string[] = [];

  for (const message of messages) {
    const role = message.role === "user" ? "User" : "Assistant";
    const text = textOf(message);
    if (text) {
      const heading = isContextSummaryMessage(message)
        ? `${role} (prior summary)`
        : role;
      lines.push(`${heading}: ${snippet(text)}`);
    }

    for (const part of message.parts) {
      if (!isToolUIPart(part)) {
        continue;
      }
      const name = getToolName(part);
      const input = "input" in part ? part.input : undefined;
      const path = readPath(input);
      lines.push(`  [${name}${path ? ` ${path}` : ""}]`);
    }
  }

  const transcript = lines.join("\n").trim();
  if (transcript.length <= TRANSCRIPT_MAX_CHARS) {
    return transcript;
  }
  return `${transcript.slice(transcript.length - TRANSCRIPT_MAX_CHARS)}`;
}

const SUMMARIZE_INSTRUCTIONS = `You compress a coding-agent conversation into a concise context summary for a future turn.

Write a structured summary covering:
- User goal
- Current app/workspace state (key files, what already works)
- Decisions and constraints
- What was done
- Open issues / next steps

Be specific about file paths. Omit tool traces, raw code dumps, and small talk. Use short bullet lists. Do not mention that you are a summarizer.`;

export async function defaultGenerateContextSummary(input: {
  transcript: string;
  guidance?: string;
}): Promise<string> {
  const modelId = process.env.AI_MODEL ?? "deepseek/deepseek-v4-flash";
  const guidance = input.guidance?.trim();
  const { text } = await generateText({
    model: modelId,
    instructions: SUMMARIZE_INSTRUCTIONS,
    prompt: [
      guidance ? `User guidance: ${guidance}\n\n` : "",
      "Conversation:\n",
      input.transcript,
    ].join(""),
    maxOutputTokens: 2_048,
  });
  return text.trim();
}

function fallbackSummary(messages: UIMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user");
  const goal = firstUser ? snippet(textOf(firstUser), 240) : "(unspecified)";
  const files = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolUIPart(part) || !("input" in part)) {
        continue;
      }
      const path = readPath(part.input);
      if (path) {
        files.add(path);
      }
    }
  }
  const fileList = [...files].slice(0, 24);
  return [
    `User goal: ${goal || "(unspecified)"}`,
    fileList.length > 0
      ? `Files touched: ${fileList.join(", ")}`
      : "Files touched: (none recorded)",
    "Earlier turns were dropped to free context. Re-read the workspace if details are missing.",
  ].join("\n");
}

export function canSummarizeMessages(
  messages: UIMessage[],
  options?: { keepRecent?: number },
): boolean {
  if (messages.length < MIN_MESSAGES) {
    return false;
  }
  const keepRecent = options?.keepRecent ?? CONTEXT_KEEP_RECENT_MESSAGES;
  const tokens = estimateUiTokens(messages);
  return messages.length > keepRecent || tokens >= MIN_TOKENS_TO_SUMMARIZE;
}

/** Split so dropped history is summarized and recent turns stay intact. */
export function resolveSummarySplit(
  messages: UIMessage[],
  keepRecent: number,
): number {
  let splitAt = Math.min(
    Math.max(1, messages.length - keepRecent),
    messages.length - 1,
  );
  while (
    splitAt < messages.length - 1 &&
    messages[splitAt]?.role !== "user"
  ) {
    splitAt += 1;
  }
  return splitAt;
}

export function buildSummarizedMessages(input: {
  messages: UIMessage[];
  summaryText: string;
  estimatedTokensBefore: number;
  keepRecent?: number;
}): UIMessage[] {
  const keepRecent = input.keepRecent ?? CONTEXT_KEEP_RECENT_MESSAGES;
  const splitAt = resolveSummarySplit(input.messages, keepRecent);
  const recent = input.messages.slice(splitAt);
  const summaryMessage: UIMessage = {
    id: generateId(),
    role: "assistant",
    metadata: {
      kind: CONTEXT_SUMMARY_KIND,
      estimatedTokensBefore: input.estimatedTokensBefore,
      estimatedTokensAfter: 0,
    } satisfies ContextSummaryMetadata,
    parts: [
      {
        type: "text",
        text: `${CONTEXT_SUMMARY_HEADING}\n\n${input.summaryText.trim()}`,
      },
    ],
  };
  const next = [summaryMessage, ...recent];
  const estimatedTokensAfter = estimateUiTokens(next);
  summaryMessage.metadata = {
    kind: CONTEXT_SUMMARY_KIND,
    estimatedTokensBefore: input.estimatedTokensBefore,
    estimatedTokensAfter,
  } satisfies ContextSummaryMetadata;
  return next;
}

export async function summarizeMessages(
  messages: UIMessage[],
  options?: {
    guidance?: string;
    keepRecent?: number;
    generateSummary?: GenerateContextSummary;
  },
): Promise<SummarizeMessagesResult> {
  if (!canSummarizeMessages(messages, { keepRecent: options?.keepRecent })) {
    throw new SummarizeContextError(
      "Not enough conversation to summarize yet.",
      "not_enough_history",
    );
  }

  const estimatedTokensBefore = estimateUiTokens(messages);
  const keepRecent = options?.keepRecent ?? CONTEXT_KEEP_RECENT_MESSAGES;
  const splitAt = resolveSummarySplit(messages, keepRecent);
  const older = messages.slice(0, splitAt);
  const transcript = buildConversationTranscript(older);
  const generate = options?.generateSummary ?? defaultGenerateContextSummary;

  let summaryText = "";
  try {
    summaryText = (await generate({
      transcript,
      guidance: options?.guidance,
    })).trim();
  } catch {
    summaryText = "";
  }
  if (!summaryText) {
    summaryText = fallbackSummary(older);
  }

  const next = buildSummarizedMessages({
    messages,
    summaryText,
    estimatedTokensBefore,
    keepRecent,
  });

  return {
    messages: next,
    estimatedTokensBefore,
    estimatedTokensAfter: estimateUiTokens(next),
    droppedMessageCount: Math.max(0, messages.length - (next.length - 1)),
  };
}
