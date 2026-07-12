import { createModelCallToUIChunkTransform } from "@ai-sdk/workflow";
import { createUIMessageStreamResponse, type UIMessage } from "ai";
import { NextResponse } from "next/server";
import { start } from "workflow/api";

import {
  appendMessages,
  deriveSessionTitle,
  getSession,
  updateSession,
} from "@/lib/session/store";
import { builderChat } from "@/workflow/builder-chat";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const session = await getSession(sessionId);

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const { messages }: { messages: UIMessage[] } = await request.json();

  const title =
    session.title === "New Project"
      ? deriveSessionTitle(messages) ?? session.title
      : session.title;

  await appendMessages(sessionId, messages);
  if (title !== session.title) {
    await updateSession(sessionId, { title });
  }

  const run = await start(builderChat, [sessionId, messages]);
  await updateSession(sessionId, { lastRunId: run.runId });

  return createUIMessageStreamResponse({
    stream: run.readable.pipeThrough(createModelCallToUIChunkTransform()),
    headers: {
      "x-workflow-run-id": run.runId,
    },
  });
}
