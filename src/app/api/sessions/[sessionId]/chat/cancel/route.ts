import { NextResponse } from "next/server";
import type { UIMessage } from "ai";

import { cancelSessionRun } from "@/lib/chat/cancel-session-run";
import {
  requireSessionAuth,
  SessionAccessDeniedError,
  UnauthenticatedError,
} from "@/lib/session/auth-context";

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

  let clientAssistant: UIMessage | null = null;
  try {
    const body = (await request.json()) as {
      assistant?: UIMessage | null;
    } | null;
    if (body?.assistant?.role === "assistant") {
      clientAssistant = body.assistant;
    }
  } catch {
    // Empty body is fine — the authoritative server snapshot is sufficient.
  }

  try {
    const result = await cancelSessionRun(sessionId, auth, { clientAssistant });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status },
      );
    }
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    throw error;
  }
}