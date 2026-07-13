import { createModelCallToUIChunkTransform } from "@ai-sdk/workflow";
import { createUIMessageStreamResponse, type UIMessage } from "ai";
import { NextResponse } from "next/server";
import { start } from "workflow/api";

import {
  getSessionAuthContext,
  SessionAccessDeniedError,
} from "@/lib/session/auth-context";
import {
  deriveSessionTitle,
  getSession,
  replaceMessages,
  updateSession,
} from "@/lib/session/store";
import { builderChat } from "@/workflow/builder-chat";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const auth = await getSessionAuthContext(request);

  try {
    const session = await getSession(sessionId, auth);

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const { messages }: { messages: UIMessage[] } = await request.json();

    const title =
      session.title === "New Project"
        ? (deriveSessionTitle(messages) ?? session.title)
        : session.title;

    // Persist the client thread immediately so a refresh mid-turn still has
    // the latest user message. Assistant output is merged when the workflow
    // completes.
    await replaceMessages(sessionId, messages, auth);
    if (title !== session.title) {
      await updateSession(sessionId, { title }, auth);
    }

    const run = await start(builderChat, [sessionId, messages]);
    await updateSession(
      sessionId,
      {
        lastRunId: run.runId,
        runStatus: "running",
      },
      auth,
    );

    return createUIMessageStreamResponse({
      stream: run.readable.pipeThrough(createModelCallToUIChunkTransform()),
      headers: {
        "x-workflow-run-id": run.runId,
      },
    });
  } catch (error) {
    if (error instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    throw error;
  }
}
