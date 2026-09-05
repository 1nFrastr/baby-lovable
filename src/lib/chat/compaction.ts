import type { UIMessage } from "ai";

import { CONTEXT_KEEP_RECENT_MESSAGES } from "@/lib/agent/context-compact";

export const COMPACTION_PART_TYPE = "data-compaction" as const;

export interface CompactionPartData {
  auto: boolean;
  overflow?: boolean;
  tailStartId?: string;
}

export type CompactionUIPart = {
  type: typeof COMPACTION_PART_TYPE;
  data: CompactionPartData;
};

export interface CompactionMessageMetadata {
  summary?: boolean;
}

export type ChatDisplayItem =
  | { type: "sealed"; messages: UIMessage[] }
  | { type: "divider"; message: UIMessage }
  | { type: "summary"; message: UIMessage }
  | { type: "message"; message: UIMessage };

export interface CompletedCompaction {
  nailIndex: number;
  summaryIndex: number;
  tailStartId?: string;
}

export interface CompactionPlan {
  needed: boolean;
  head: UIMessage[];
  tail: UIMessage[];
  tailStartId?: string;
  currentUser?: UIMessage;
  previousSummary?: string;
}

const MAX_TOOL_CHARS = 2_000;
const MAX_TRANSCRIPT_CHARS = 80_000;

export const COMPACTION_SYSTEM_PROMPT = `You are an anchored context summarization assistant for coding sessions.

Summarize only the conversation history you are given. The newest turns may be kept verbatim outside your summary, so focus on the older context that still matters for continuing the work.

If the prompt includes a <previous-summary> block, treat it as the current anchored summary. Update it with the new history by preserving still-true details, removing stale details, and merging in new facts.

Always follow the exact output structure requested by the user prompt. Keep every section, preserve exact file paths and identifiers when known, and prefer terse bullets over paragraphs.

Do not answer the conversation itself. Do not mention that you are summarizing, compacting, or merging context. Respond in the same language as the conversation.`;

export const COMPACTION_SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`;

export function compactionNailId(turnId: string): string {
  return `cmp_${turnId}`;
}

export function compactionSummaryId(turnId: string): string {
  return `csm_${turnId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function isCompactionPart(
  part: UIMessage["parts"][number],
): part is CompactionUIPart {
  if (part.type !== COMPACTION_PART_TYPE) {
    return false;
  }
  return isRecord((part as CompactionUIPart).data);
}

export function getCompactionData(
  message: UIMessage,
): CompactionPartData | undefined {
  const part = message.parts.find(isCompactionPart);
  if (!part) {
    return undefined;
  }
  const data = part.data;
  return {
    auto: data.auto === true,
    overflow: data.overflow === true ? true : undefined,
    tailStartId:
      typeof data.tailStartId === "string" && data.tailStartId.length > 0
        ? data.tailStartId
        : undefined,
  };
}

export function isCompactionMessage(message: UIMessage): boolean {
  return message.role === "user" && message.parts.some(isCompactionPart);
}

export function isSummaryMessage(message: UIMessage): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const metadata = message.metadata;
  return isRecord(metadata) && metadata.summary === true;
}

export function getTailStartId(message: UIMessage): string | undefined {
  return getCompactionData(message)?.tailStartId;
}

export function summaryText(message: UIMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<UIMessage["parts"][number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function latestSummaryText(messages: UIMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || !isSummaryMessage(message)) {
      continue;
    }
    const text = summaryText(message);
    if (text) {
      return text;
    }
  }
  return undefined;
}

export function createCompactionNail(input: {
  turnId: string;
  auto: boolean;
  overflow?: boolean;
  tailStartId?: string;
}): UIMessage {
  const data: CompactionPartData = {
    auto: input.auto,
  };
  if (input.overflow) {
    data.overflow = true;
  }
  if (input.tailStartId) {
    data.tailStartId = input.tailStartId;
  }
  return {
    id: compactionNailId(input.turnId),
    role: "user",
    parts: [{ type: COMPACTION_PART_TYPE, data }],
  };
}

export function createCompactionSummary(input: {
  turnId: string;
  text: string;
}): UIMessage {
  return {
    id: compactionSummaryId(input.turnId),
    role: "assistant",
    metadata: { summary: true } satisfies CompactionMessageMetadata,
    parts: [{ type: "text", text: input.text }],
  };
}

export function findLatestCompletedCompaction(
  messages: UIMessage[],
): CompletedCompaction | undefined {
  for (let index = messages.length - 1; index >= 1; index -= 1) {
    const summary = messages[index];
    const nail = messages[index - 1];
    if (!summary || !nail) {
      continue;
    }
    if (!isSummaryMessage(summary) || !summaryText(summary)) {
      continue;
    }
    if (!isCompactionMessage(nail)) {
      continue;
    }
    return {
      nailIndex: index - 1,
      summaryIndex: index,
      tailStartId: getTailStartId(nail),
    };
  }
  return undefined;
}

/**
 * Model-side copy of the ledger: latest completed summary + retained tail +
 * messages after that compaction. Compaction nails are never included.
 */
export function filterCompacted(messages: UIMessage[]): UIMessage[] {
  const completed = findLatestCompletedCompaction(messages);
  if (!completed) {
    return messages.filter((message) => !isCompactionMessage(message));
  }

  const { nailIndex, summaryIndex, tailStartId } = completed;
  const summary = messages[summaryIndex];
  if (!summary) {
    return messages.filter((message) => !isCompactionMessage(message));
  }

  const tailStartIndex = tailStartId
    ? messages.findIndex((message) => message.id === tailStartId)
    : -1;
  const tail =
    tailStartIndex >= 0 && tailStartIndex < nailIndex
      ? messages.slice(tailStartIndex, nailIndex)
      : [];
  const after = messages.slice(summaryIndex + 1);

  return [summary, ...tail, ...after].filter(
    (message) => !isCompactionMessage(message),
  );
}

export function toPromptUiMessages(messages: UIMessage[]): UIMessage[] {
  return filterCompacted(messages);
}

export function insertCompactionBefore(
  messages: UIMessage[],
  beforeMessageId: string | undefined,
  nail: UIMessage,
  summary: UIMessage,
): UIMessage[] {
  if (
    messages.some((message) => message.id === nail.id) &&
    messages.some((message) => message.id === summary.id)
  ) {
    return messages;
  }

  const without = messages.filter(
    (message) => message.id !== nail.id && message.id !== summary.id,
  );
  const insertAt = beforeMessageId
    ? without.findIndex((message) => message.id === beforeMessageId)
    : -1;
  if (insertAt < 0) {
    return [...without, nail, summary];
  }
  return [
    ...without.slice(0, insertAt),
    nail,
    summary,
    ...without.slice(insertAt),
  ];
}

function lastRealUser(messages: UIMessage[]): UIMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message &&
      message.role === "user" &&
      !isCompactionMessage(message)
    ) {
      return message;
    }
  }
  return undefined;
}

/**
 * Split the filtered prompt view into a summarizable head and a verbatim tail.
 * Does not look at token counts — callers decide whether the budget is exceeded.
 */
export function planCompaction(
  messages: UIMessage[],
  keepRecent: number = CONTEXT_KEEP_RECENT_MESSAGES,
): CompactionPlan {
  const filtered = filterCompacted(messages);
  const currentUser = lastRealUser(filtered);
  const body =
    currentUser && filtered[filtered.length - 1]?.id === currentUser.id
      ? filtered.slice(0, -1)
      : filtered;

  if (body.length <= keepRecent) {
    return {
      needed: false,
      head: [],
      tail: body,
      currentUser,
      previousSummary: latestSummaryText(filtered),
    };
  }

  const tail = body.slice(-keepRecent);
  const head = body.slice(0, -keepRecent);
  return {
    needed: head.length > 0,
    head,
    tail,
    tailStartId: tail[0]?.id,
    currentUser,
    previousSummary: latestSummaryText(head) ?? latestSummaryText(filtered),
  };
}

function truncateChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n…[truncated ${value.length - maxChars} chars]`;
}

function partTranscript(part: UIMessage["parts"][number]): string | undefined {
  if (part.type === "text") {
    const text = part.text.trim();
    return text || undefined;
  }
  if (part.type === "reasoning") {
    return undefined;
  }
  if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
    const toolName =
      part.type === "dynamic-tool"
        ? part.toolName
        : part.type.slice("tool-".length);
    const input =
      "input" in part && part.input != null
        ? truncateChars(JSON.stringify(part.input), 400)
        : "";
    let output = "";
    if ("output" in part && part.output != null) {
      output = truncateChars(
        typeof part.output === "string"
          ? part.output
          : JSON.stringify(part.output),
        MAX_TOOL_CHARS,
      );
    } else if ("errorText" in part && typeof part.errorText === "string") {
      output = truncateChars(part.errorText, 400);
    }
    return [`tool ${toolName}`, input && `input: ${input}`, output && `output: ${output}`]
      .filter(Boolean)
      .join("\n");
  }
  return undefined;
}

export function transcriptOf(messages: UIMessage[]): string {
  const chunks: string[] = [];
  for (const message of messages) {
    if (isCompactionMessage(message) || isSummaryMessage(message)) {
      continue;
    }
    const body = message.parts
      .map(partTranscript)
      .filter((line): line is string => Boolean(line))
      .join("\n");
    if (!body) {
      continue;
    }
    chunks.push(`${message.role}:\n${body}`);
  }
  return truncateChars(chunks.join("\n\n"), MAX_TRANSCRIPT_CHARS);
}

export function buildCompactionUserPrompt(input: {
  head: UIMessage[];
  previousSummary?: string;
}): string {
  const previous =
    input.previousSummary?.trim() ||
    latestSummaryText(input.head);
  const history = transcriptOf(
    input.head.filter((message) => !isSummaryMessage(message)),
  );
  const sections = [COMPACTION_SUMMARY_TEMPLATE];
  if (previous) {
    sections.push(`<previous-summary>\n${previous}\n</previous-summary>`);
  }
  sections.push(
    history
      ? `<conversation-history>\n${history}\n</conversation-history>`
      : "<conversation-history>(none)</conversation-history>",
  );
  return sections.join("\n\n");
}

function displayItem(message: UIMessage): ChatDisplayItem {
  if (isCompactionMessage(message)) {
    return { type: "divider", message };
  }
  if (isSummaryMessage(message)) {
    return { type: "summary", message };
  }
  return { type: "message", message };
}

/**
 * UI grouping derived from the snapshot ledger. Not a stored view.
 * Latest completed compaction seals messages before `tailStartId`.
 */
export function groupMessagesForDisplay(
  messages: UIMessage[],
): ChatDisplayItem[] {
  const completed = findLatestCompletedCompaction(messages);
  if (!completed) {
    return messages.map(displayItem);
  }

  const { nailIndex, summaryIndex, tailStartId } = completed;
  const nail = messages[nailIndex];
  const summary = messages[summaryIndex];
  if (!nail || !summary) {
    return messages.map(displayItem);
  }

  const tailStartIndex = tailStartId
    ? messages.findIndex((message) => message.id === tailStartId)
    : -1;
  const sealedEnd =
    tailStartIndex >= 0 && tailStartIndex <= nailIndex
      ? tailStartIndex
      : nailIndex;

  const items: ChatDisplayItem[] = [];
  const sealed = messages.slice(0, sealedEnd);
  if (sealed.length > 0) {
    items.push({ type: "sealed", messages: sealed });
  }
  items.push({ type: "divider", message: nail });
  items.push({ type: "summary", message: summary });

  if (tailStartIndex >= 0 && tailStartIndex < nailIndex) {
    for (const message of messages.slice(tailStartIndex, nailIndex)) {
      items.push(displayItem(message));
    }
  }

  for (const message of messages.slice(summaryIndex + 1)) {
    items.push(displayItem(message));
  }

  return items;
}
