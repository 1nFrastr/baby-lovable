import { type ModelCallStreamPart } from "@ai-sdk/workflow";
import { convertToModelMessages, isStepCount, type UIMessage } from "ai";
import { getWritable } from "workflow";

import { createBuilderAgent } from "./builder-agent";

import {
  getBuildErrorStep,
  getSessionStep,
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

  const result = await agent.stream({
    messages: modelMessages,
    writable: getWritable<ModelCallStreamPart>(),
    stopWhen: isStepCount(30),
    runtimeContext,
    toolsContext,
  });

  await saveSessionMessagesStep(
    sessionId,
    messages,
    result.messages,
    previousModelCount,
  );

  return { messages: result.messages };
}
