import { createModelCallToUIChunkTransform } from "@ai-sdk/workflow";
import { createUIMessageStreamResponse } from "ai";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getRun } from "workflow/api";

import {
  requireSessionAuth,
  SessionAccessDeniedError,
  UnauthenticatedError,
} from "@/lib/session/auth-context";
import { getSession } from "@/lib/session/store";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string; runId: string }> },
) {
  const { sessionId, runId } = await params;
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

    if (session.lastRunId && session.lastRunId !== runId) {
      return NextResponse.json(
        { error: "Run does not belong to this session" },
        { status: 403 },
      );
    }

    const startIndex = Number(
      new URL(request.url).searchParams.get("startIndex") ?? "0",
    );

    const run = await getRun(runId);
    const rawReadable = run.getReadable({ startIndex });
    const tailIndex = await rawReadable.getTailIndex();
    const stream = rawReadable.pipeThrough(
      createModelCallToUIChunkTransform(),
    );

    // Must use createUIMessageStreamResponse — raw Response(stream) sends JSON
    // objects instead of SSE and crashes with ERR_INVALID_ARG_TYPE.
    return createUIMessageStreamResponse({
      stream,
      headers: {
        "x-workflow-run-id": runId,
        "x-workflow-stream-tail-index": String(tailIndex),
      },
    });
  } catch (error) {
    if (error instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    throw error;
  }
}
