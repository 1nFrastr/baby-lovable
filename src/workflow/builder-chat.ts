import { type ModelCallStreamPart } from "@ai-sdk/workflow";
import { convertToModelMessages, isStepCount, type UIMessage } from "ai";
import { getWritable } from "workflow";

import { createAgentTrace, formatTraceStdout } from "@/lib/agent/agent-trace";
import { runAgentStreamWithAutoContinue } from "@/lib/agent/auto-continue";
import { createBuilderAgent } from "./builder-agent";

import {
  getBuildErrorStep,
  getSessionStep,
  modelMessagesToAssistantUIMessage,
  saveSessionMessagesStep,
} from "./builder-chat-steps";

export async function builderChat(sessionId: string, messages: UIMessage[]) {
  "use workflow";

  const session = await getSessionStep(sessionId);
  const sandboxMode = session.sandboxMode;
  const modelMessages = await convertToModelMessages(messages);

  // Surface any live dev-server compile error from the user's previous edits so
  // the agent starts the turn aware of what is currently broken in preview.
  const buildError = await getBuildErrorStep(sessionId);
  if (buildError) {
    modelMessages.push({
      role: "user",
      content: `[Preview build error] The live dev server currently fails to compile. Fix this before other work:\n\n${buildError}`,
    });
  }

  // Anything injected above is transient context, not part of the saved thread.
  const previousModelCount = modelMessages.length;
  const { agent, toolsContext, runtimeContext } = createBuilderAgent(
    sessionId,
    sandboxMode,
  );

  const maxSteps = 30;
  const trace = createAgentTrace({
    sessionId,
    maxSteps,
    channel: "web",
  });
  const startedAt = Date.now();
  const writable = getWritable<ModelCallStreamPart>();

  const result = await runAgentStreamWithAutoContinue({
    initialMessages: modelMessages,
    writable,
    onAutoContinue: (n) => {
      console.log(
        formatTraceStdout(
          sessionId,
          "INFO",
          `auto-continue #${n} after finish=length (invisible to user)`,
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
