import { type ModelCallStreamPart } from "@ai-sdk/workflow";
import { convertToModelMessages, isStepCount, type UIMessage } from "ai";
import { getWritable } from "workflow";

import { createAgentTrace, formatTraceStdout } from "@/lib/agent/agent-trace";
import { runAgentStreamWithAutoContinue } from "@/lib/agent/auto-continue";
import { resolveMaxOutputTokens } from "@/lib/agent/max-output-tokens";
import { toPromptUiMessages } from "@/lib/chat/compaction";
import { finalizeInterruptedMessages } from "@/lib/chat/interrupt-assistant";
import { repairUiMessages } from "@/lib/chat/repair-messages";
import {
  appendRecordedStep,
  createTurnAssistantMessage,
  type ToolCompletion,
} from "@/lib/chat/turn-progress";
import { createBuilderAgent } from "./builder-agent";
import { ensureCompactionStep } from "./compaction-step";

import {
  closeAgentWritableStep,
  getSessionStep,
} from "./builder-chat-steps";
import {
  failTurnStep,
  finishTurnStep,
  persistStepSnapshotStep,
} from "./chat-turn-steps";

export async function builderChat(
  sessionId: string,
  messages: UIMessage[],
  turnId: string,
  assistantMessageId: string,
) {
  "use workflow";

  await getSessionStep(sessionId);
  // Failed turns can leave consecutive user rows or an interrupted assistant
  // with no tool results. Repair order first, then drop incomplete tool calls
  // so the prompt does not throw AI_InvalidPromptError / AI_MissingToolResultsError.
  const repairedMessages = repairUiMessages(
    finalizeInterruptedMessages(messages),
  );
  if (repairedMessages.length !== messages.length) {
    console.log(
      formatTraceStdout(
        sessionId,
        "WARN",
        `repaired message sequence ${messages.length} → ${repairedMessages.length} (consecutive/empty rows from a failed turn)`,
      ),
    );
  }
  const compactedMessages = await ensureCompactionStep(
    sessionId,
    turnId,
    repairedMessages,
    "turn",
  );
  const modelMessages = await convertToModelMessages(
    toPromptUiMessages(compactedMessages),
    {
      ignoreIncompleteToolCalls: true,
    },
  );

  const { agent, toolsContext, runtimeContext } = createBuilderAgent(
    sessionId,
    { turnId, assistantMessageId },
  );

  const maxSteps = 30;
  const modelId = process.env.AI_MODEL ?? "deepseek/deepseek-v4-flash";
  const maxOutputTokens = resolveMaxOutputTokens(modelId);
  const trace = createAgentTrace({
    sessionId,
    maxSteps,
    channel: "web",
  });
  const startedAt = Date.now();
  const writable = getWritable<ModelCallStreamPart>();
  const toolCompletions = new Map<string, ToolCompletion>();
  let assistant = createTurnAssistantMessage(assistantMessageId);
  let checkpoint = -1;

  let result;
  try {
    result = await runAgentStreamWithAutoContinue({
      initialMessages: modelMessages,
      writable,
      maxSteps,
      maxOutputTokens,
      finalizeWritable: closeAgentWritableStep,
      onAutoContinue: (n, reason) => {
        console.log(
          formatTraceStdout(
            sessionId,
            "INFO",
            `auto-continue #${n} after finish=${reason} (invisible to user)`,
          ),
        );
      },
      onSanitized: (ids) => {
        console.log(
          formatTraceStdout(
            sessionId,
            "WARN",
            `removed ${ids.length} incomplete tool call(s) from history: ${ids.slice(0, 5).join(", ")}${ids.length > 5 ? "…" : ""}`,
          ),
        );
      },
      streamOnce: async ({
        messages: passMessages,
        preventClose,
        sendFinish,
      }) => {
        return agent.stream({
          messages: passMessages,
          writable,
          stopWhen: isStepCount(maxSteps),
          runtimeContext,
          toolsContext,
          preventClose,
          sendFinish,
          ...trace.hooks,
          onToolExecutionEnd: async (event) => {
            await trace.hooks.onToolExecutionEnd(event);
            toolCompletions.set(
              event.toolCall.toolCallId,
              event.success
                ? { success: true, output: event.output }
                : {
                    success: false,
                    errorText:
                      event.error instanceof Error
                        ? event.error.message
                        : String(event.error),
                  },
            );
          },
          onStepEnd: async (step) => {
            await trace.hooks.onStepEnd(step);
            assistant = appendRecordedStep(
              assistant,
              {
                content: step.content,
                reasoning: step.reasoning.flatMap((part) =>
                  "text" in part ? [{ text: part.text }] : [],
                ),
                text: step.text,
              },
              toolCompletions,
            );
            checkpoint += 1;
            await persistStepSnapshotStep(
              sessionId,
              turnId,
              checkpoint,
              assistant,
            );
          },
        });
      },
    });
  } catch (error) {
    await failTurnStep(sessionId, turnId);
    throw error;
  }

  trace.finalizeTurn(result, startedAt, assistant);
  await finishTurnStep(
    sessionId,
    turnId,
    checkpoint,
    assistant,
  );

  return { messages: result.messages };
}
