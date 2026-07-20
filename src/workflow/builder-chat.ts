import { type ModelCallStreamPart } from "@ai-sdk/workflow";
import { convertToModelMessages, isStepCount, type UIMessage } from "ai";
import { getWritable } from "workflow";

import { createAgentTrace, formatTraceStdout } from "@/lib/agent/agent-trace";
import { runAgentStreamWithAutoContinue } from "@/lib/agent/auto-continue";
import { resolveMaxOutputTokens } from "@/lib/agent/max-output-tokens";
import { createBuilderAgent } from "./builder-agent";

import {
  closeAgentWritableStep,
  getSessionStep,
  markSessionRunFailedStep,
  modelMessagesToAssistantUIMessage,
  saveSessionMessagesStep,
} from "./builder-chat-steps";

export async function builderChat(sessionId: string, messages: UIMessage[]) {
  "use workflow";

  const session = await getSessionStep(sessionId);
  const sandboxMode = session.sandboxMode;
  // Interrupted turns leave tool parts without results — drop them so the
  // model prompt does not throw AI_MissingToolResultsError.
  const modelMessages = await convertToModelMessages(messages, {
    ignoreIncompleteToolCalls: true,
  });

  const previousModelCount = modelMessages.length;
  const { agent, toolsContext, runtimeContext } = createBuilderAgent(
    sessionId,
    sandboxMode,
  );

  const maxSteps = 30;
  const modelId = process.env.AI_MODEL ?? "minimax/minimax-m3";
  const maxOutputTokens = resolveMaxOutputTokens(modelId);
  const trace = createAgentTrace({
    sessionId,
    maxSteps,
    channel: "web",
  });
  const startedAt = Date.now();
  const writable = getWritable<ModelCallStreamPart>();

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
  } catch (error) {
    if (result) {
      await saveSessionMessagesStep(
        sessionId,
        messages,
        result.messages,
        previousModelCount,
      );
    } else {
      await markSessionRunFailedStep(sessionId);
    }
    throw error;
  }

  const assistantMessage = modelMessagesToAssistantUIMessage(
    result.messages,
    previousModelCount,
  );
  trace.finalizeTurn(result, startedAt, assistantMessage);

  await saveSessionMessagesStep(
    sessionId,
    messages,
    result.messages,
    previousModelCount,
  );

  return { messages: result.messages };
}
