import { createModelCallToUIChunkTransform } from "@ai-sdk/workflow";
import { createUIMessageStreamResponse, type UIMessage } from "ai";
import { NextResponse } from "next/server";
import { start } from "workflow/api";

import {
  requireSessionAuth,
  SessionAccessDeniedError,
  UnauthenticatedError,
} from "@/lib/session/auth-context";
import { materializeDraftFromRun } from "@/lib/chat/draft-materializer";
import { mergeClientMessagesWithPersisted } from "@/lib/chat/merge-messages";
import {
  createEmptyDraft,
  deleteDraft,
  writeDraft,
} from "@/lib/session/draft-store";
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
  let auth;
  try {
    auth = await requireSessionAuth(request);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw error;
  }

  try {
    const session = await getSession(sessionId, auth);

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const { messages: clientMessages }: { messages: UIMessage[] } =
      await request.json();

    const messages = mergeClientMessagesWithPersisted(
      session.messages,
      clientMessages,
    );

    const title =
      session.title === "New Project"
        ? (deriveSessionTitle(messages) ?? session.title)
        : session.title;

    // Persist the merged thread immediately so a refresh mid-turn still has
    // the latest user message. Assistant output is merged when the workflow
    // completes.
    await replaceMessages(sessionId, messages, auth);
    if (title !== session.title) {
      await updateSession(sessionId, { title }, auth);
    }

    await deleteDraft(sessionId, auth.userId);

    const run = await start(builderChat, [sessionId, messages]);
    await updateSession(
      sessionId,
      {
        lastRunId: run.runId,
        runStatus: "running",
      },
      auth,
    );

    await writeDraft(
      sessionId,
      createEmptyDraft(run.runId),
      auth.userId,
    );

    // Detached — survives client disconnect; overwrites draft.json as chunks arrive.
    void materializeDraftFromRun(sessionId, run.runId, auth.userId).catch(
      (error) => {
        console.error(
          `[chat] draft materializer failed session=${sessionId} run=${run.runId}:`,
          error,
        );
      },
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
