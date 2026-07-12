import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import {
  convertToModelMessages,
  isStepCount,
  type LanguageModelUsage,
  type ModelMessage,
  type UIMessage,
} from "ai";

import { createBuilderAgent } from "@/workflow/builder-agent";
import { modelMessagesToAssistantUIMessage } from "@/workflow/builder-chat-steps";
import type { SandboxMode } from "@/lib/sandbox/types";

import { logger, truncate } from "./logger";

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
  const { ensurePreviewBootstrap, getPreviewReport } = await import(
    "@/lib/sandbox/dev-server"
  );
  ensurePreviewBootstrap(sessionId);

  // Surface any live dev-server compile error from the previous edits so the
  // agent starts the turn aware of what is currently broken in preview.
  const buildError = (await getPreviewReport(sessionId)).buildError;
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

  // Shared rendering state between the writable sink and callbacks so that
  // streamed text and structured event logs don't clobber each other.
  const render = { assistantOpen: false, reasoningOpen: false };

  const closeAssistantBlock = () => {
    if (render.assistantOpen || render.reasoningOpen) {
      logger.assistantEnd();
      render.assistantOpen = false;
      render.reasoningOpen = false;
    }
  };

  // Sink that receives raw model stream parts for real-time token output.
  const writable = new WritableStream<ModelCallStreamPart>({
    write(part) {
      switch (part.type) {
        case "text-delta": {
          if (render.reasoningOpen) {
            logger.assistantEnd();
            render.reasoningOpen = false;
          }
          if (!render.assistantOpen) {
            logger.assistantStart();
            render.assistantOpen = true;
          }
          logger.assistantDelta(part.text);
          break;
        }
        case "reasoning-delta": {
          if (!render.reasoningOpen && !render.assistantOpen) {
            logger.raw("\n");
            logger.system("reasoning ▾");
            render.reasoningOpen = true;
          }
          logger.reasoningDelta(part.text);
          break;
        }
        default:
          break;
      }
    },
  });

  const startedAt = Date.now();

  const result = await agent.stream({
    messages: modelMessages,
    writable,
    stopWhen: isStepCount(maxSteps),
    runtimeContext,
    toolsContext,

    experimental_onStart({ model, messages: startMessages }) {
      const modelId = typeof model === "string" ? model : model.modelId;
      logger.info(
        `agent started · model=${modelId} · contextMessages=${startMessages.length} · maxSteps=${maxSteps}`,
      );
    },

    experimental_onStepStart({ stepNumber }) {
      closeAssistantBlock();
      logger.step(`step #${stepNumber} → calling model…`);
    },

    onToolExecutionStart({ toolCall, stepNumber }) {
      closeAssistantBlock();
      logger.tool(
        `[step ${stepNumber}] ${toolCall.toolName}(${truncate(toolCall.input, 400)})`,
      );
    },

    onToolExecutionEnd(event) {
      if (event.success) {
        logger.toolOk(
          `${event.toolCall.toolName} ✓ ${event.durationMs}ms · ${truncate(event.output)}`,
        );
      } else {
        logger.toolErr(
          `${event.toolCall.toolName} ✗ ${event.durationMs}ms · ${truncate(event.error)}`,
        );
      }
    },

    onStepEnd(step) {
      closeAssistantBlock();
      const usage = step.usage;
      const toolCalls = step.toolCalls?.length ?? 0;
      logger.step(
        `step #${step.stepNumber} done · finish=${step.finishReason} · toolCalls=${toolCalls} · tokens(in/out)=${usage?.inputTokens ?? 0}/${usage?.outputTokens ?? 0}`,
      );
    },

    onError({ error }) {
      closeAssistantBlock();
      logger.error(error instanceof Error ? error.stack ?? error.message : String(error));
    },
  });

  closeAssistantBlock();

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const usage = result.totalUsage;
  logger.success(
    `turn complete · steps=${result.steps.length} · finish=${result.finishReason} · ${elapsed}s · tokens(in/out/total)=${usage.inputTokens ?? 0}/${usage.outputTokens ?? 0}/${usage.totalTokens ?? 0}`,
  );

  const assistantMessage = modelMessagesToAssistantUIMessage(
    result.messages,
    previousModelCount,
  );

  return {
    assistantMessage,
    modelMessages: result.messages,
    usage,
    stepCount: result.steps.length,
  };
}
