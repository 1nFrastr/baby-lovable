import { createModelCallToUIChunkTransform } from "@ai-sdk/workflow";
import type { NextRequest } from "next/server";
import { getRun } from "workflow/api";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string; runId: string }> },
) {
  const { runId } = await params;
  const startIndex = Number(
    new URL(request.url).searchParams.get("startIndex") ?? "0",
  );

  const run = await getRun(runId);
  const readable = run
    .getReadable({ startIndex })
    .pipeThrough(createModelCallToUIChunkTransform());

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "x-workflow-run-id": runId,
    },
  });
}
