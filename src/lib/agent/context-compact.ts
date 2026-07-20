import { pruneMessages, type ModelMessage } from "ai";

import { sanitizeModelMessages } from "./sanitize-messages";

/** Soft budget before we drop older tool rounds entirely (chars/4 ≈ tokens). */
export const CONTEXT_COMPACT_TOKENS = Math.max(
  8_000,
  Number(process.env.AI_CONTEXT_COMPACT_TOKENS ?? 100_000),
);

/** Keep the newest N messages fully intact; older tool payloads are stubbed. */
export const CONTEXT_KEEP_RECENT_MESSAGES = Math.max(
  2,
  Number(process.env.AI_CONTEXT_KEEP_RECENT ?? 8),
);

const FILE_MUTATION_TOOLS = new Set(["writeFile", "editFile"]);
const LARGE_RESULT_TOOLS = new Set([
  "readFile",
  "listFiles",
  "searchFiles",
  "runCommand",
  "testPreview",
]);

/** Rough token estimate — good enough for compaction triggers. */
export function estimateTokens(messages: ModelMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n…[truncated ${value.length - maxChars} chars]`;
}

function compactToolInput(toolName: string, input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }

  const record = { ...(input as Record<string, unknown>) };

  if (FILE_MUTATION_TOOLS.has(toolName)) {
    if (typeof record.content === "string" && record.content.length > 200) {
      const path =
        typeof record.path === "string" ? record.path : "(unknown path)";
      record.content = `[compacted: ${path} · ${record.content.length} chars — already written; use readFile if needed]`;
    }
    if (typeof record.oldString === "string" && record.oldString.length > 200) {
      record.oldString = truncateText(record.oldString, 120);
    }
    if (typeof record.newString === "string" && record.newString.length > 200) {
      record.newString = truncateText(record.newString, 120);
    }
  }

  return record;
}

/** Tiny stub for old tool results — keeps call/result pairing, drops payload. */
function stubToolOutput(toolName: string, output: unknown): unknown {
  if (output != null && typeof output === "object" && !Array.isArray(output)) {
    const rec = output as Record<string, unknown>;
    if (rec.type === "json" || rec.type === "text") {
      return {
        type: "text",
        value: `[dropped ${toolName} output — re-read workspace if needed]`,
      };
    }
    if (typeof rec.ok === "boolean") {
      return { ok: rec.ok, compacted: true, tool: toolName };
    }
  }
  return { compacted: true, tool: toolName };
}

function compactToolOutput(toolName: string, output: unknown): unknown {
  if (output == null) {
    return output;
  }

  // AI SDK ToolResultOutput wrappers
  if (typeof output === "object" && !Array.isArray(output)) {
    const rec = output as Record<string, unknown>;
    if (rec.type === "text" && typeof rec.value === "string") {
      if (rec.value.length > 400) {
        return { ...rec, value: truncateText(rec.value, 400) };
      }
      return output;
    }
    if (rec.type === "json") {
      const serialized = JSON.stringify(rec.value ?? null);
      if (serialized.length > 600) {
        return {
          type: "text",
          value: `[compacted ${toolName} json · ${serialized.length} chars]`,
        };
      }
      return output;
    }
  }

  if (typeof output === "string") {
    return output.length > 400 ? truncateText(output, 400) : output;
  }

  if (!LARGE_RESULT_TOOLS.has(toolName)) {
    const serialized = JSON.stringify(output);
    if (serialized.length <= 800) {
      return output;
    }
    return {
      ok: typeof (output as { ok?: unknown }).ok === "boolean"
        ? (output as { ok: boolean }).ok
        : true,
      compacted: true,
      note: `${toolName} result compacted (${serialized.length} chars)`,
    };
  }

  if (typeof output === "object" && !Array.isArray(output)) {
    const rec = { ...(output as Record<string, unknown>) };
    if (typeof rec.content === "string" && rec.content.length > 300) {
      const path = typeof rec.path === "string" ? rec.path : undefined;
      rec.content = `[compacted${path ? `: ${path}` : ""} · ${rec.content.length} chars — re-read if needed]`;
    }
    if (typeof rec.stdout === "string" && rec.stdout.length > 300) {
      rec.stdout = truncateText(rec.stdout, 300);
    }
    if (typeof rec.stderr === "string" && rec.stderr.length > 200) {
      rec.stderr = truncateText(rec.stderr, 200);
    }
    if (Array.isArray(rec.files) && rec.files.length > 40) {
      rec.files = [
        ...rec.files.slice(0, 40),
        `…[${rec.files.length - 40} more]`,
      ];
    }
    if (Array.isArray(rec.matches) && rec.matches.length > 20) {
      rec.matches = rec.matches.slice(0, 20);
      rec.truncated = true;
    }
    return rec;
  }

  const serialized = JSON.stringify(output);
  if (serialized.length > 800) {
    return {
      compacted: true,
      note: `${toolName} result compacted (${serialized.length} chars)`,
    };
  }
  return output;
}

/**
 * @param mode
 * - `truncate` — shrink large payloads (soft compact)
 * - `drop` — replace tool results with a one-line stub (older history)
 */
function compactMessageParts(
  message: ModelMessage,
  mode: "truncate" | "drop",
): ModelMessage {
  if (message.role !== "assistant" && message.role !== "tool") {
    return message;
  }
  if (typeof message.content === "string") {
    return message;
  }

  const content = message.content.map((part) => {
    if (part.type === "tool-call") {
      return {
        ...part,
        input: compactToolInput(part.toolName, part.input),
      };
    }
    if (part.type === "tool-result") {
      const output =
        mode === "drop"
          ? stubToolOutput(part.toolName, part.output)
          : compactToolOutput(part.toolName, part.output);
      return {
        ...part,
        output: output as typeof part.output,
      };
    }
    return part;
  });

  return { ...message, content } as ModelMessage;
}

/**
 * Shrink model-bound history:
 * 1. Sanitize incomplete tool call/result pairs (interrupted turns).
 * 2. Always stub/truncate tool payloads older than `keepRecent`.
 * 3. If still over budget, drop older tool rounds via pruneMessages.
 *
 * Yes — every tool output normally sits in context until compacted. This is
 * the simple discard path: keep recent full, stub older payloads, prune if needed.
 */
export function compactModelMessages(
  messages: ModelMessage[],
  options?: {
    tokenBudget?: number;
    keepRecent?: number;
  },
): {
  messages: ModelMessage[];
  estimatedTokens: number;
  compacted: boolean;
  sanitizedToolCallIds: string[];
} {
  const tokenBudget = options?.tokenBudget ?? CONTEXT_COMPACT_TOKENS;
  const keepRecent = options?.keepRecent ?? CONTEXT_KEEP_RECENT_MESSAGES;
  const before = estimateTokens(messages);

  const sanitized = sanitizeModelMessages(messages);
  let next = sanitized.messages;
  const keepFrom = Math.max(0, next.length - keepRecent);

  // Always stub older tool outputs (not only when over budget).
  let changed = sanitized.removedToolCallIds.length > 0;
  if (keepFrom > 0) {
    const beforeStub = estimateTokens(next);
    next = next.map((message, index) =>
      index < keepFrom ? compactMessageParts(message, "drop") : message,
    );
    if (estimateTokens(next) < beforeStub) {
      changed = true;
    }
  }

  let after = estimateTokens(next);
  if (after > tokenBudget) {
    // Still too large — drop older tool-call/result parts entirely.
    next = pruneMessages({
      messages: next,
      reasoning: "all",
      toolCalls: `before-last-${Math.max(keepRecent, 3)}-messages`,
      emptyMessages: "remove",
    });
    const again = sanitizeModelMessages(next);
    next = again.messages;
    after = estimateTokens(next);
    changed = true;
  }

  return {
    messages: next,
    estimatedTokens: after,
    compacted: changed || after < before || next.length !== messages.length,
    sanitizedToolCallIds: sanitized.removedToolCallIds,
  };
}
