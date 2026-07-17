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

  // Warm up the preview (install deps + boot dev server) in the background so
  // it is ready by the time the agent calls checkPreview — the agent should
  // never have to run `pnpm install` / `pnpm dev` itself.
  const { startPreview, getBuildError } = await import(
    "@/lib/sandbox/preview"
  );
  startPreview(sessionId);

  // Non-blocking: only inject a previously captured compile error. Preview
  // install/dev-server continues in the background while the agent runs.
  const buildError = await getBuildError(sessionId);
  if (buildError) {
    modelMessages.push({
      role: "user",
      content: `[Preview build error] The live dev server currently fails to compile. Fix this before other work:\n\n${buildError}`,
    });
  }

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
    onAutoContinue: (n) => {
      trace.logInfo(
        `auto-continue #${n} after finish=length (invisible to user)`,
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
