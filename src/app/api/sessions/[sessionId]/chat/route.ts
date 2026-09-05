import { createModelCallToUIChunkTransform } from "@ai-sdk/workflow";
import {
  createUIMessageStreamResponse,
  generateId,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { after, NextResponse } from "next/server";
import { start } from "workflow/api";

import {
  cancelSessionRun,
  cancelWorkflowRun,
} from "@/lib/chat/cancel-session-run";
import { capReasoningStream } from "@/lib/chat/cap-reasoning-stream";
import { bindAssistantMessageId } from "@/lib/chat/stable-message-stream";
import {
  awaitRuntimeDesired,
  kickRuntimeDesired,
} from "@/lib/sandbox/preview";
import {
  requireSessionAuth,
  SessionAccessDeniedError,
  UnauthenticatedError,
} from "@/lib/session/auth-context";
import { getSession } from "@/lib/session/store";
import {
  attachSessionRun,
  claimSessionTurn,
  failSessionTurn,
} from "@/lib/session/turn-store";
import { isActiveRunStatus } from "@/lib/session/types";
import { builderChat } from "@/workflow/builder-chat";

/** Preview warm under after() must outlive the chat response headers. */
export const maxDuration = 300;

const MAX_CLAIM_ATTEMPTS = 4;

function emptyUiMessageStream() {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      controller.close();
    },
  });
}

function emptyRunResponse(
  runId: string,
  assistantMessageId: string,
) {
  return createUIMessageStreamResponse({
    stream: emptyUiMessageStream(),
    headers: {
      "x-workflow-run-id": runId,
      "x-assistant-message-id": assistantMessageId,
    },
  });
}

function latestUserMessage(messages: UIMessage[]): UIMessage | null {
  const message = [...messages]
    .reverse()
    .find(
      (candidate) =>
        candidate.role === "user" &&
        candidate.parts.some(
          (part) => part.type === "text" && part.text.trim().length > 0,
        ),
    );
  if (!message || !message.id) {
    return null;
  }
  return message;
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

  let claimedTurnId: string | null = null;
  let assistantMessageId: string | null = null;
  let startedRunId: string | null = null;

  try {
    const body = (await request.json()) as { messages?: UIMessage[] };
    const userMessage = latestUserMessage(body.messages ?? []);
    if (!userMessage) {
      return NextResponse.json(
        { error: "A non-empty user message is required" },
        { status: 400 },
      );
    }

    let claimedSession = null as Awaited<
      ReturnType<typeof getSession>
    >;

    for (
      let attempt = 0;
      attempt < MAX_CLAIM_ATTEMPTS;
      attempt += 1
    ) {
      const current = await getSession(sessionId, auth);
      if (!current) {
        return NextResponse.json(
          { error: "Session not found" },
          { status: 404 },
        );
      }

      if (current.activeTurnId || isActiveRunStatus(current.runStatus)) {
        const cancelled = await cancelSessionRun(sessionId, auth, {
          expectedTurnId: current.activeTurnId,
        });
        if (!cancelled.ok) {
          return NextResponse.json(
            { error: cancelled.error },
            { status: cancelled.status },
          );
        }
        continue;
      }

      const turnId = `turn_${generateId()}`;
      const stableAssistantId = generateId();
      const claim = await claimSessionTurn(
        {
          sessionId,
          turnId,
          assistantMessageId: stableAssistantId,
          userMessage,
        },
        auth,
      );
      if (!claim.ok) {
        if (claim.reason === "active_turn") {
          continue;
        }
        if (claim.reason === "duplicate_user_message") {
          return NextResponse.json(
            { error: "This user message was already submitted" },
            { status: 409 },
          );
        }
        return NextResponse.json(
          { error: "Session not found" },
          { status: 404 },
        );
      }

      claimedTurnId = turnId;
      assistantMessageId = stableAssistantId;
      claimedSession = claim.session;
      break;
    }

    if (!claimedTurnId || !assistantMessageId || !claimedSession) {
      return NextResponse.json(
        { error: "Could not acquire the session turn lease" },
        { status: 409 },
      );
    }

    // Prelude: upgrade to preview-ready without blocking the AI loop.
    await kickRuntimeDesired(sessionId, "preview-ready");
    after(() => awaitRuntimeDesired(sessionId, "preview-ready"));

    if (request.signal.aborted) {
      await cancelSessionRun(sessionId, auth, {
        expectedTurnId: claimedTurnId,
      });
      return new Response(null, { status: 499 });
    }

    // The persisted placeholder is the final row; the model prompt ends at
    // the user message immediately before it.
    const workflowMessages = claimedSession.messages.slice(0, -1);
    const run = await start(builderChat, [
      sessionId,
      workflowMessages,
      claimedTurnId,
      assistantMessageId,
    ]);
    startedRunId = run.runId;

    const attached = await attachSessionRun(
      sessionId,
      claimedTurnId,
      run.runId,
      auth,
    );
    if (
      !attached.ok ||
      attached.session.runStatus === "cancelling" ||
      request.signal.aborted
    ) {
      await cancelWorkflowRun(run.runId).catch(() => {});
      await cancelSessionRun(sessionId, auth, {
        expectedTurnId: claimedTurnId,
      });
      return emptyRunResponse(run.runId, assistantMessageId);
    }

    const stream = run.readable
      .pipeThrough(createModelCallToUIChunkTransform())
      .pipeThrough(capReasoningStream())
      .pipeThrough(bindAssistantMessageId(assistantMessageId));

    return createUIMessageStreamResponse({
      stream,
      headers: {
        "x-workflow-run-id": run.runId,
        "x-assistant-message-id": assistantMessageId,
      },
    });
  } catch (error) {
    if (startedRunId) {
      await cancelWorkflowRun(startedRunId).catch(() => {});
    }
    if (claimedTurnId) {
      await failSessionTurn(sessionId, claimedTurnId).catch(() => {});
    }
    if (error instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    throw error;
  }
}
