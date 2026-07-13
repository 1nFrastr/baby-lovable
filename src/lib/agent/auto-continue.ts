import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import type { LanguageModelUsage, ModelMessage } from "ai";

import type { AgentStreamResult } from "./agent-trace";

/** Max invisible auto-continue rounds after finishReason=length (0 = disabled). */
export const AUTO_CONTINUE_MAX = Math.max(
  0,
  Number(process.env.AI_AUTO_CONTINUE_MAX ?? 2),
);

/** Transient model message — never persisted to session UI history. */
export const AUTO_CONTINUE_HINT =
  "[Auto-continue] Your previous model output was cut off because the per-step output token limit was reached. Continue the same task from where you left off. Do not repeat tool calls that already succeeded. If a file write was interrupted, readFile first, then editFile or writeFile. Prefer splitting very large files into smaller components under src/components/.";

export function shouldAutoContinue(
  finishReason: string,
  continuationCount: number,
): boolean {
  return finishReason === "length" && continuationCount < AUTO_CONTINUE_MAX;
}

/** Strip system messages before a continue pass (instructions are on the agent). */
function messagesForContinuation(passMessages: ModelMessage[]): ModelMessage[] {
  return [
    ...passMessages.filter((message) => message.role !== "system"),
    { role: "user", content: AUTO_CONTINUE_HINT },
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
  streamOnce: (options: {
    messages: ModelMessage[];
    preventClose: boolean;
    sendFinish: boolean;
  }) => Promise<AgentStreamPassResult>;
  onAutoContinue?: (continuationNumber: number) => void;
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
 * finishReason=length. Transient continue hints are model-only (not UI).
 */
export async function runAgentStreamWithAutoContinue({
  initialMessages,
  writable,
  streamOnce,
  onAutoContinue,
  finalizeWritable,
}: RunAgentStreamWithAutoContinueOptions): Promise<AgentStreamResult> {
  let messages = initialMessages;
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

    if (!shouldAutoContinue(pass.finishReason, continuationCount)) {
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
    onAutoContinue?.(continuationCount);

    messages = messagesForContinuation(pass.messages);
  }
}
