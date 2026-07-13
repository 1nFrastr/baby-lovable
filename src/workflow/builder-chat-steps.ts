import { generateId, type ModelMessage, type UIMessage } from "ai";

export function modelMessagesToAssistantUIMessage(
  modelMessages: ModelMessage[],
  startIndex: number,
): UIMessage | null {
  const newMessages = modelMessages.slice(startIndex);
  const parts: UIMessage["parts"] = [];

  for (const message of newMessages) {
    if (message.role === "assistant") {
      const content =
        typeof message.content === "string"
          ? [{ type: "text" as const, text: message.content }]
          : message.content;

      for (const part of content) {
        if (typeof part === "string") {
          parts.push({ type: "text", text: part });
          continue;
        }

        if (part.type === "text") {
          parts.push({ type: "text", text: part.text });
        }

        if (part.type === "tool-call") {
          parts.push({
            type: `tool-${part.toolName}` as `tool-${string}`,
            toolCallId: part.toolCallId,
            state: "output-available",
            input: part.input,
            output: undefined,
          });
        }
      }
    }

    if (message.role === "tool") {
      const content = Array.isArray(message.content)
        ? message.content
        : [message.content];

      for (const part of content) {
        if (typeof part === "string" || part.type !== "tool-result") {
          continue;
        }

        const existing = parts.find(
          (candidate) =>
            "toolCallId" in candidate &&
            candidate.toolCallId === part.toolCallId,
        );

        if (
          existing &&
          "state" in existing &&
          "toolCallId" in existing &&
          existing.type.startsWith("tool-")
        ) {
          existing.state = "output-available";
          existing.output = part.output;
        }
      }
    }
  }

  if (parts.length === 0) {
    return null;
  }

  return {
    id: generateId(),
    role: "assistant",
    parts,
  };
}

export async function getSessionStep(sessionId: string) {
  "use step";

  const { getSession } = await import("@/lib/session/store");
  const session = await getSession(sessionId);

  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  return session;
}

export async function getBuildErrorStep(
  sessionId: string,
): Promise<string | null> {
  "use step";

  const { getPreviewReport } = await import("@/lib/sandbox/dev-server");
  const report = await getPreviewReport(sessionId);
  return report.buildError;
}

export async function saveSessionMessagesStep(
  sessionId: string,
  uiMessages: UIMessage[],
  modelMessages: ModelMessage[],
  previousModelCount: number,
) {
  "use step";

  const { deriveSessionTitle, getSession, replaceMessages, updateSession } =
    await import("@/lib/session/store");

  const session = await getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const assistantMessage = modelMessagesToAssistantUIMessage(
    modelMessages,
    previousModelCount,
  );

  const mergedMessages = assistantMessage
    ? [...uiMessages, assistantMessage]
    : uiMessages;

  const title =
    session.title === "New Project"
      ? (deriveSessionTitle(mergedMessages) ?? session.title)
      : session.title;

  await replaceMessages(sessionId, mergedMessages);
  if (title !== session.title) {
    await updateSession(sessionId, { title });
  }

  await updateSession(sessionId, {
    runStatus: "completed",
    lastRunId: null,
  });

  return { messageCount: mergedMessages.length };
}

export async function markSessionRunFailedStep(sessionId: string) {
  "use step";

  const { updateSession } = await import("@/lib/session/store");
  await updateSession(sessionId, {
    runStatus: "failed",
    lastRunId: null,
  });
}

/** Close the agent writable stream — must run as a step inside workflows. */
export async function closeAgentWritableStep(
  writable: WritableStream<import("@ai-sdk/workflow").ModelCallStreamPart>,
) {
  "use step";

  const writer = writable.getWriter();
  try {
    await writer.write({ type: "finish" });
  } finally {
    writer.releaseLock();
  }
  await writable.close();
}
