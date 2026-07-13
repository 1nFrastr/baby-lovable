import {
  generateId,
  isToolUIPart,
  type UIMessage,
  type UIMessageChunk,
} from "ai";

/** Drop a trailing partial assistant message before reconnecting to a stream. */
export function prepareMessagesForResume(messages: UIMessage[]): UIMessage[] {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") {
    return messages.slice(0, -1);
  }
  return messages;
}

/** Collapse duplicate message ids — keeps the latest copy. */
export function dedupeMessagesById(messages: UIMessage[]): UIMessage[] {
  const indexById = new Map<string, number>();
  const result: UIMessage[] = [];

  for (const message of messages) {
    const existingIndex = indexById.get(message.id);
    if (existingIndex != null) {
      result[existingIndex] = message;
      continue;
    }
    indexById.set(message.id, result.length);
    result.push(message);
  }

  return result;
}

/**
 * `useChat` pushes a new assistant row whenever the stream emits a `start`
 * chunk with a fresh `messageId` (multi-step agent turns). Merge consecutive
 * assistant rows so intro text, tool calls, and closing text stay in order.
 */
export function mergeConsecutiveAssistantMessages(
  messages: UIMessage[],
): UIMessage[] {
  const deduped = dedupeMessagesById(messages);
  const result: UIMessage[] = [];

  for (const message of deduped) {
    const prev = result[result.length - 1];

    if (message.role === "assistant" && prev?.role === "assistant") {
      result[result.length - 1] = {
        id: message.id,
        role: "assistant",
        parts: mergeAssistantParts(prev.parts, message.parts),
      };
      continue;
    }

    result.push(message);
  }

  return result;
}

/** Combine parts from consecutive assistant rows without dropping intro text. */
function mergeAssistantParts(
  left: UIMessage["parts"],
  right: UIMessage["parts"],
): UIMessage["parts"] {
  const result: UIMessage["parts"] = [];
  const toolIndexByCallId = new Map<string, number>();

  const ingest = (part: UIMessage["parts"][number]) => {
    if (part.type === "text") {
      ingestTextPart(result, part);
      return;
    }

    if (isToolUIPart(part)) {
      const existingIndex = toolIndexByCallId.get(part.toolCallId);
      if (existingIndex != null) {
        const existing = result[existingIndex];
        if (isToolUIPart(existing)) {
          result[existingIndex] = preferCompleteToolPart(existing, part);
        }
        return;
      }

      toolIndexByCallId.set(part.toolCallId, result.length);
      result.push(part);
      return;
    }

    result.push(part);
  };

  for (const part of left) {
    ingest(part);
  }
  for (const part of right) {
    ingest(part);
  }

  return result;
}

function ingestTextPart(
  result: UIMessage["parts"],
  part: { type: "text"; text: string },
) {
  const text = part.text;
  if (!text) {
    return;
  }

  for (let index = result.length - 1; index >= 0; index--) {
    const candidate = result[index];
    if (candidate.type !== "text") {
      continue;
    }

    if (text === candidate.text) {
      return;
    }
    if (text.startsWith(candidate.text)) {
      result[index] = part;
      return;
    }
    if (candidate.text.startsWith(text)) {
      return;
    }
    break;
  }

  result.push(part);
}

function preferCompleteToolPart<
  T extends Extract<UIMessage["parts"][number], { toolCallId: string }>,
>(left: T, right: T): T {
  if (left.state === "output-available") {
    return left;
  }
  if (right.state === "output-available") {
    return right;
  }
  return right;
}

export function normalizeChatMessages(messages: UIMessage[]): UIMessage[] {
  return mergeConsecutiveAssistantMessages(dedupeMessagesById(messages));
}

/** Module-level lock — survives React Strict Mode remount within one page load. */
const resumeClaims = new Set<string>();

export function claimResumeLock(sessionId: string, runId: string): boolean {
  const key = `${sessionId}:${runId}`;
  if (resumeClaims.has(key)) {
    return false;
  }
  resumeClaims.add(key);
  return true;
}

export function releaseResumeLock(sessionId: string, runId: string): void {
  resumeClaims.delete(`${sessionId}:${runId}`);
}

async function* readUiMessageChunks(
  stream: ReadableStream<UIMessageChunk>,
): AsyncGenerator<UIMessageChunk> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Mirrors `useChat` resume behaviour: each stream `start` chunk with a new
 * `messageId` pushes another assistant row. Used by the CLI resume test.
 */
export async function applyResumeStreamLikeUseChat(
  initialMessages: UIMessage[],
  stream: ReadableStream<UIMessageChunk>,
): Promise<UIMessage[]> {
  const state = [...prepareMessagesForResume(initialMessages)];
  let activeAssistant: UIMessage | null = null;
  const textParts = new Map<string, { type: "text"; text: string }>();

  const commitAssistant = () => {
    if (!activeAssistant || activeAssistant.parts.length === 0) {
      return;
    }

    const last = state[state.length - 1];
    if (last?.role === "assistant" && last.id === activeAssistant.id) {
      state[state.length - 1] = activeAssistant;
      return;
    }

    state.push(activeAssistant);
  };

  for await (const chunk of readUiMessageChunks(stream)) {
    switch (chunk.type) {
      case "start": {
        if (
          activeAssistant &&
          chunk.messageId &&
          activeAssistant.id !== chunk.messageId
        ) {
          commitAssistant();
          activeAssistant = {
            id: chunk.messageId,
            role: "assistant",
            parts: [],
          };
          textParts.clear();
        } else if (!activeAssistant) {
          activeAssistant = {
            id: chunk.messageId ?? generateId(),
            role: "assistant",
            parts: [],
          };
        } else if (chunk.messageId) {
          activeAssistant.id = chunk.messageId;
        }
        break;
      }
      case "text-start": {
        if (!activeAssistant) {
          activeAssistant = {
            id: generateId(),
            role: "assistant",
            parts: [],
          };
        }
        const part = { type: "text" as const, text: "" };
        textParts.set(chunk.id, part);
        activeAssistant.parts.push(part);
        break;
      }
      case "text-delta": {
        textParts.get(chunk.id)!.text += chunk.delta;
        break;
      }
      case "text-end":
        textParts.delete(chunk.id);
        break;
      case "finish":
        commitAssistant();
        activeAssistant = null;
        break;
      default:
        break;
    }
  }

  commitAssistant();
  return state;
}

/** @deprecated Use applyResumeStreamLikeUseChat for tests. */
export async function applyResumeStreamToMessages(
  initialMessages: UIMessage[],
  stream: ReadableStream<UIMessageChunk>,
): Promise<UIMessage[]> {
  return applyResumeStreamLikeUseChat(initialMessages, stream);
}

export function countAssistantMessages(messages: UIMessage[]): number {
  return messages.filter((message) => message.role === "assistant").length;
}

export function findDuplicateMessageIds(messages: UIMessage[]): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];

  for (const message of messages) {
    if (seen.has(message.id)) {
      duplicates.push(message.id);
      continue;
    }
    seen.add(message.id);
  }

  return duplicates;
}

/** Simulates React Strict Mode firing resume twice on remount. */
export function simulateStrictModeResumeClaims(
  sessionId: string,
  runId: string,
): { first: boolean; second: boolean } {
  const first = claimResumeLock(sessionId, runId);
  const second = claimResumeLock(sessionId, runId);
  releaseResumeLock(sessionId, runId);
  return { first, second };
}

/** Build a ReadableStream from UI chunks for unit-style tests. */
export function uiChunksToStream(
  chunks: UIMessageChunk[],
): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

/** Unit-style check: intro text survives merge with a following tool-only row. */
export function runTextBeforeToolsMergeTest(): {
  ok: boolean;
  introText: string | null;
} {
  const messages: UIMessage[] = [
    {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "change to a todolist app" }],
    },
    {
      id: "assistant-a",
      role: "assistant",
      parts: [{ type: "text", text: "我先看看项目结构和依赖。" }],
    },
    {
      id: "assistant-b",
      role: "assistant",
      parts: [
        {
          type: "tool-readFile",
          toolCallId: "call-1",
          state: "output-available",
          input: { path: "package.json" },
          output: { type: "json", value: {} },
        },
      ],
    },
  ];

  const normalized = normalizeChatMessages(messages);
  const assistant = normalized.find((message) => message.role === "assistant");
  const textIndex =
    assistant?.parts.findIndex((part) => part.type === "text") ?? -1;
  const toolIndex =
    assistant?.parts.findIndex((part) => isToolUIPart(part)) ?? -1;
  const intro =
    textIndex >= 0 && assistant?.parts[textIndex]?.type === "text"
      ? assistant.parts[textIndex].text
      : null;

  return {
    ok: textIndex >= 0 && toolIndex > textIndex,
    introText: intro,
  };
}

export async function runMultiStartResumeNormalization(): Promise<{
  rawAssistants: number;
  normalizedAssistants: number;
  mergedText: string | null;
}> {
  const user: UIMessage = {
    id: "user-1",
    role: "user",
    parts: [{ type: "text", text: "hello" }],
  };

  const stream = uiChunksToStream([
    { type: "start", messageId: "assistant-a" },
    { type: "text-start", id: "0" },
    { type: "text-delta", id: "0", delta: "我来帮你" },
    { type: "start", messageId: "assistant-b" },
    { type: "text-start", id: "1" },
    { type: "text-delta", id: "1", delta: "我来帮你创建" },
    { type: "finish", finishReason: "stop" },
  ]);

  const raw = await applyResumeStreamLikeUseChat([user], stream);
  const normalized = normalizeChatMessages(raw);
  const assistant = normalized.find((message) => message.role === "assistant");
  const mergedText =
    assistant?.parts.find((part) => part.type === "text")?.text ?? null;

  return {
    rawAssistants: countAssistantMessages(raw),
    normalizedAssistants: countAssistantMessages(normalized),
    mergedText,
  };
}
