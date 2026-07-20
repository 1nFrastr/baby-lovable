import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import type { LanguageModelUsage, ModelMessage } from "ai";

import type { AgentStreamResult } from "./agent-trace";
import { compactModelMessages } from "./context-compact";

/** Max invisible auto-continue rounds after finishReason=length / step budget (0 = disabled). */
export const AUTO_CONTINUE_MAX = Math.max(
  0,
  Number(process.env.AI_AUTO_CONTINUE_MAX ?? 3),
);

/** Transient model message — never persisted to session UI history. */
export const AUTO_CONTINUE_HINT_LENGTH =
  "[Auto-continue] Your previous model output was cut off because the per-step output token limit was reached. Continue the same task from where you left off. Do not repeat tool calls that already succeeded. If a file write was interrupted, readFile first, then editFile or writeFile. Prefer splitting very large files into smaller components under src/components/.";

export const AUTO_CONTINUE_HINT_STEPS =
  "[Auto-continue] You hit the per-pass step budget before finishing. Continue the same task from where you left off. Do not repeat tool calls that already succeeded. Prefer small focused files; call checkPreview before finishing if you edited files.";

/** @deprecated use AUTO_CONTINUE_HINT_LENGTH */
export const AUTO_CONTINUE_HINT = AUTO_CONTINUE_HINT_LENGTH;

export function shouldAutoContinue(
  finishReason: string,
  continuationCount: number,
  options?: { stepCount?: number; maxSteps?: number },
): boolean {
  if (continuationCount >= AUTO_CONTINUE_MAX) {
    return false;
  }
  if (finishReason === "length") {
    return true;
  }
  // Step budget exhausted while the model still wanted tools — start a fresh pass.
  if (
    finishReason === "tool-calls" &&
    options?.maxSteps != null &&
    options.stepCount != null &&
    options.stepCount >= options.maxSteps
  ) {
    return true;
  }
  return false;
}

function continueHintFor(finishReason: string): string {
  return finishReason === "tool-calls"
    ? AUTO_CONTINUE_HINT_STEPS
    : AUTO_CONTINUE_HINT_LENGTH;
}

/** Strip system messages before a continue pass (instructions are on the agent). */
function messagesForContinuation(
  passMessages: ModelMessage[],
  finishReason: string,
): ModelMessage[] {
  const compacted = compactModelMessages(
    passMessages.filter((message) => message.role !== "system"),
  ).messages;

  return [
    ...compacted,
    { role: "user", content: continueHintFor(finishReason) },
  ];
}

function sumUsageField(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a == null && b == null) {
    return undefined;
  }
  return (a ?? 0) + (b ?? 0);
}

function addUsage(
  a: LanguageModelUsage,
  b: LanguageModelUsage,
): LanguageModelUsage {
  return {
    inputTokens: sumUsageField(a.inputTokens, b.inputTokens),
    outputTokens: sumUsageField(a.outputTokens, b.outputTokens),
    totalTokens: sumUsageField(a.totalTokens, b.totalTokens),
    inputTokenDetails: {
      noCacheTokens: sumUsageField(
        a.inputTokenDetails?.noCacheTokens,
        b.inputTokenDetails?.noCacheTokens,
      ),
      cacheReadTokens: sumUsageField(
        a.inputTokenDetails?.cacheReadTokens,
        b.inputTokenDetails?.cacheReadTokens,
      ),
      cacheWriteTokens: sumUsageField(
        a.inputTokenDetails?.cacheWriteTokens,
        b.inputTokenDetails?.cacheWriteTokens,
      ),
    },
    outputTokenDetails: {
      textTokens: sumUsageField(
        a.outputTokenDetails?.textTokens,
        b.outputTokenDetails?.textTokens,
      ),
      reasoningTokens: sumUsageField(
        a.outputTokenDetails?.reasoningTokens,
        b.outputTokenDetails?.reasoningTokens,
      ),
    },
  };
}

function mergeStreamResults(
  accumulated: AgentStreamResult | null,
  next: AgentStreamResult,
): AgentStreamResult {
  if (!accumulated) {
    return next;
  }

  return {
    messages: next.messages,
    steps: [...accumulated.steps, ...next.steps],
    finishReason: next.finishReason,
    totalUsage: addUsage(accumulated.totalUsage, next.totalUsage),
    autoContinueCount: next.autoContinueCount,
  };
}

async function finalizeWritableDefault(
  writable: WritableStream<ModelCallStreamPart>,
): Promise<void> {
  const writer = writable.getWriter();
  try {
    await writer.write({ type: "finish" } as unknown as ModelCallStreamPart);
  } finally {
    writer.releaseLock();
  }
  await writable.close();
}

export interface AgentStreamPassResult {
  messages: ModelMessage[];
  steps: AgentStreamResult["steps"];
  finishReason: string;
  totalUsage: LanguageModelUsage;
}

export interface RunAgentStreamWithAutoContinueOptions {
  initialMessages: ModelMessage[];
  writable?: WritableStream<ModelCallStreamPart>;
  /** Per-pass step budget (used to detect incomplete tool-calls finishes). */
  maxSteps?: number;
  streamOnce: (options: {
    messages: ModelMessage[];
    preventClose: boolean;
    sendFinish: boolean;
  }) => Promise<AgentStreamPassResult>;
  onAutoContinue?: (
    continuationNumber: number,
    reason: "length" | "tool-calls",
  ) => void;
  /** Fired when incomplete tool call/result pairs are stripped from history. */
  onSanitized?: (removedToolCallIds: string[]) => void;
  /**
   * Close the workflow writable after the final pass. Required in `'use workflow'`
   * context — plain `getWriter()` throws outside a step.
   */
  finalizeWritable?: (
    writable: WritableStream<ModelCallStreamPart>,
  ) => Promise<void>;
}

/**
 * Run the agent stream, silently continuing when a pass ends with
 * finishReason=length (output token cap) or tool-calls at the step budget.
 * Compacts oversized file/tool history before each pass. Transient continue
 * hints are model-only (not UI).
 */
export async function runAgentStreamWithAutoContinue({
  initialMessages,
  writable,
  maxSteps,
  streamOnce,
  onAutoContinue,
  onSanitized,
  finalizeWritable,
}: RunAgentStreamWithAutoContinueOptions): Promise<AgentStreamResult> {
  // Sanitize incomplete tool pairs + stub old tool payloads before every pass.
  const prepared = compactModelMessages(initialMessages);
  if (prepared.sanitizedToolCallIds.length > 0) {
    onSanitized?.(prepared.sanitizedToolCallIds);
  }
  let messages = prepared.messages;
  let continuationCount = 0;
  let accumulated: AgentStreamResult | null = null;

  for (;;) {
    const pass = await streamOnce({
      messages,
      preventClose: true,
      sendFinish: false,
    });

    const passResult: AgentStreamResult = {
      messages: pass.messages,
      steps: pass.steps,
      finishReason: pass.finishReason,
      totalUsage: pass.totalUsage,
    };

    accumulated = mergeStreamResults(accumulated, passResult);

    const reason = pass.finishReason === "tool-calls" ? "tool-calls" : "length";
    if (
      !shouldAutoContinue(pass.finishReason, continuationCount, {
        stepCount: pass.steps.length,
        maxSteps,
      })
    ) {
      if (writable) {
        const close = finalizeWritable ?? finalizeWritableDefault;
        await close(writable);
      }
      return {
        ...accumulated,
        autoContinueCount: continuationCount,
      };
    }

    continuationCount += 1;
    onAutoContinue?.(continuationCount, reason);

    messages = messagesForContinuation(pass.messages, pass.finishReason);
  }
}
