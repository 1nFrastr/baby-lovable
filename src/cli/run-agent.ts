import {
  convertToModelMessages,
  isStepCount,
  type LanguageModelUsage,
  type ModelMessage,
  type UIMessage,
} from "ai";

import { createCliAgentTrace } from "@/lib/agent/agent-trace-cli";
import { runAgentStreamWithAutoContinue } from "@/lib/agent/auto-continue";
import { createBuilderAgent } from "@/workflow/builder-agent";
import { modelMessagesToAssistantUIMessage } from "@/workflow/builder-chat-steps";
import type { SandboxMode } from "@/lib/sandbox/types";

export interface RunAgentOptions {
  sessionId: string;
  sandboxMode: SandboxMode;
  /** Full conversation history, including the latest user message. */
  messages: UIMessage[];
  /** Max agent steps before stopping. Defaults to 30 (matches the web app). */
  maxSteps?: number;
}

export interface RunAgentResult {
  assistantMessage: UIMessage | null;
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
  sandboxMode,
  messages,
  maxSteps = 30,
}: RunAgentOptions): Promise<RunAgentResult> {
  const modelMessages = await convertToModelMessages(messages);

  // Non-blocking prelude: preview-ready via reconciler (same as web chat).
  const { kickRuntimeDesired } = await import("@/lib/sandbox/preview");
  await kickRuntimeDesired(sessionId, "preview-ready");

  const previousModelCount = modelMessages.length;

  const { agent, toolsContext, runtimeContext } = createBuilderAgent(
    sessionId,
    sandboxMode,
  );

  const trace = createCliAgentTrace({
    sessionId,
    maxSteps,
    channel: "cli",
  });
  const startedAt = Date.now();
  const writable = trace.createWritable();

  const result = await runAgentStreamWithAutoContinue({
    initialMessages: modelMessages,
    writable,
    maxSteps,
    onAutoContinue: (n, reason) => {
      trace.logInfo(
        `auto-continue #${n} after finish=${reason} (invisible to user)`,
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
    modelMessages: result.messages,
    usage: result.totalUsage,
    stepCount: result.steps.length,
  };
}
