import {
  convertToModelMessages,
  isStepCount,
  type LanguageModelUsage,
  type ModelMessage,
  type UIMessage,
} from "ai";

import { createCliAgentTrace } from "@/lib/agent/agent-trace-cli";
import { runAgentStreamWithAutoContinue } from "@/lib/agent/auto-continue";
import { resolveMaxOutputTokens } from "@/lib/agent/max-output-tokens";
import { toPromptUiMessages } from "@/lib/chat/compaction";
import { finalizeInterruptedMessages } from "@/lib/chat/interrupt-assistant";
import { repairUiMessages } from "@/lib/chat/repair-messages";
import { createBuilderAgent } from "@/workflow/builder-agent";
import { modelMessagesToAssistantUIMessage } from "@/workflow/builder-chat-steps";
import { ensureCompactionStep } from "@/workflow/compaction-step";

export interface RunAgentOptions {
  sessionId: string;
  /** Full conversation history, including the latest user message. */
  messages: UIMessage[];
  /** Max agent steps before stopping. Defaults to 30 (matches the web app). */
  maxSteps?: number;
}

export interface RunAgentResult {
  assistantMessage: UIMessage | null;
  /** Ledger used for this turn, including any compaction nail + summary. */
  messages: UIMessage[];
  modelMessages: ModelMessage[];
  usage: LanguageModelUsage;
  stepCount: number;
}

/**
 * Run a single agent turn and stream a human-readable trace to the console.
 *
 * This mirrors the web `builderChat` workflow but runs the agent directly
 * (no durable workflow runtime), which is ideal for local testing and
 * evaluation. Tool `'use step'` directives degrade to plain async calls when
 * executed outside the workflow compiler.
 */
export async function runAgentTurn({
  sessionId,
  messages,
  maxSteps = 30,
}: RunAgentOptions): Promise<RunAgentResult> {
  const repaired = repairUiMessages(finalizeInterruptedMessages(messages));
  const compactedMessages = await ensureCompactionStep(
    sessionId,
    repaired.at(-1)?.id ?? `cli_${sessionId}`,
    repaired,
    "replace",
  );
  const modelMessages = await convertToModelMessages(
    toPromptUiMessages(compactedMessages),
    {
      ignoreIncompleteToolCalls: true,
    },
  );

  // Non-blocking prelude: preview-ready via reconciler (same as web chat).
  const { kickRuntimeDesired } = await import("@/lib/sandbox/preview");
  await kickRuntimeDesired(sessionId, "preview-ready");

  const previousModelCount = modelMessages.length;

  const { agent, toolsContext, runtimeContext } = createBuilderAgent(sessionId);

  const trace = createCliAgentTrace({
    sessionId,
    maxSteps,
    channel: "cli",
  });
  const startedAt = Date.now();
  const writable = trace.createWritable();
  const modelId = process.env.AI_MODEL ?? "deepseek/deepseek-v4-flash";
  const maxOutputTokens = resolveMaxOutputTokens(modelId);

  const result = await runAgentStreamWithAutoContinue({
    initialMessages: modelMessages,
    writable,
    maxSteps,
    maxOutputTokens,
    onAutoContinue: (n, reason) => {
      trace.logInfo(
        `auto-continue #${n} after finish=${reason} (invisible to user)`,
      );
    },
    onSanitized: (ids) => {
      trace.logWarn(
        `removed ${ids.length} incomplete tool call(s) from history: ${ids.slice(0, 5).join(", ")}${ids.length > 5 ? "…" : ""}`,
      );
    },
    streamOnce: async ({ messages, preventClose, sendFinish }) => {
      return agent.stream({
        messages,
        writable,
        stopWhen: isStepCount(maxSteps),
        runtimeContext,
        toolsContext,
        preventClose,
        sendFinish,
        ...trace.hooks,
      });
    },
  });

  const assistantMessage = modelMessagesToAssistantUIMessage(
    result.messages,
    previousModelCount,
  );
  trace.finalizeTurn(result, startedAt, assistantMessage);

  return {
    assistantMessage,
    messages: compactedMessages,
    modelMessages: result.messages,
    usage: result.totalUsage,
    stepCount: result.steps.length,
  };
}
