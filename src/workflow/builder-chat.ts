import { type ModelCallStreamPart } from "@ai-sdk/workflow";
import { convertToModelMessages, isStepCount, type UIMessage } from "ai";
import { getWritable } from "workflow";

import { createBuilderAgent } from "./builder-agent";

import {
  getSessionStep,
  saveSessionMessagesStep,
} from "./builder-chat-steps";

export async function builderChat(sessionId: string, messages: UIMessage[]) {
  "use workflow";

  const session = await getSessionStep(sessionId);
  const sandboxMode = session.sandboxMode;
  const modelMessages = await convertToModelMessages(messages);
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
