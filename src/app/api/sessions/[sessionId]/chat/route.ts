import { createModelCallToUIChunkTransform } from "@ai-sdk/workflow";
import {
  createUIMessageStreamResponse,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { after, NextResponse } from "next/server";
import { start } from "workflow/api";

import { cancelWorkflowRun } from "@/lib/chat/cancel-session-run";
import { materializeDraftFromRun } from "@/lib/chat/draft-materializer";
import { mergeClientMessagesWithPersisted } from "@/lib/chat/merge-messages";
import {
  awaitRuntimeDesired,
  kickRuntimeDesired,
} from "@/lib/sandbox/preview";
import {
  requireSessionAuth,
  SessionAccessDeniedError,
  UnauthenticatedError,
} from "@/lib/session/auth-context";
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

/** Preview warm under after() must outlive the chat response headers. */
export const maxDuration = 300;

function emptyUiMessageStream() {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      controller.close();
    },
  });
}

async function discardStartedRun(sessionId: string, runId: string) {
  try {
    await cancelWorkflowRun(runId);
  } catch (error) {
    console.error(
      `[chat] cancel unstarted run failed session=${sessionId} run=${runId}:`,
      error,
    );
  }
  return createUIMessageStreamResponse({
    stream: emptyUiMessageStream(),
    headers: {
      "x-workflow-run-id": runId,
    },
  });
}

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

  let claimedPending = false;
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
    // Claim the turn so a leftover `cancelled` from the previous stop cannot
    // discard this new send, while a Stop during kick still wins.
    await updateSession(sessionId, { runStatus: "pending" }, auth);
    claimedPending = true;

    // Prelude: upgrade to preview-ready without blocking the AI loop.
    await kickRuntimeDesired(sessionId, "preview-ready");
    after(() => awaitRuntimeDesired(sessionId, "preview-ready"));

    const preStart = await getSession(sessionId, auth);
    if (request.signal.aborted || preStart?.runStatus === "cancelled") {
      if (preStart?.runStatus !== "cancelled") {
        await updateSession(sessionId, { runStatus: "cancelled" }, auth);
      }
      claimedPending = false;
      return createUIMessageStreamResponse({
        stream: emptyUiMessageStream(),
      });
    }

    const run = await start(builderChat, [sessionId, messages]);

    const latest = await getSession(sessionId, auth);
    if (request.signal.aborted || latest?.runStatus === "cancelled") {
      claimedPending = false;
      if (latest?.runStatus !== "cancelled") {
        await updateSession(sessionId, { runStatus: "cancelled" }, auth);
      }
      return discardStartedRun(sessionId, run.runId);
    }

    await updateSession(
      sessionId,
      {
        lastRunId: run.runId,
        runStatus: "running",
      },
      auth,
    );
    claimedPending = false;

    await writeDraft(
      sessionId,
      createEmptyDraft(run.runId),
      auth.userId,
    );

    // Detached — survives client disconnect; updates the Supabase draft as chunks arrive.
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
    if (claimedPending) {
      try {
        const latest = await getSession(sessionId, auth);
        if (latest?.runStatus === "pending" && !latest.lastRunId) {
          await updateSession(sessionId, { runStatus: "idle" }, auth);
        }
      } catch {
        // Best-effort unlock if the turn claim never reached a workflow run.
      }
    }
    if (error instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    throw error;
  }
}
