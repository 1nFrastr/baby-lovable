import { NextResponse } from "next/server";

import {
  ensureDevServer,
  getPreviewStatus,
  hasNodeModules,
  restartDevServer,
  resolvePreviewStatus,
  stopDevServer,
} from "@/lib/sandbox/dev-server";
import {
  getSessionAuthContext,
  SessionAccessDeniedError,
} from "@/lib/session/auth-context";
import { getSession } from "@/lib/session/store";

export async function GET(
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

    const preview = await resolvePreviewStatus(sessionId);
    return NextResponse.json({ preview });
  } catch (error) {
    if (error instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    throw error;
  }
}

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

    const body = (await request.json().catch(() => ({}))) as {
      action?: "start" | "restart";
    };

    const hasDeps = await hasNodeModules(sessionId);
    if (!hasDeps) {
      return NextResponse.json({
        preview: { status: "needs_install" as const },
      });
    }

    const preview =
      body.action === "restart"
        ? await restartDevServer(sessionId)
        : await ensureDevServer(sessionId);

    return NextResponse.json({ preview });
  } catch (error) {
    if (error instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    throw error;
  }
}

export async function DELETE(
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

    await stopDevServer(sessionId);
    return NextResponse.json({ preview: getPreviewStatus(sessionId) });
  } catch (error) {
    if (error instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    throw error;
  }
}
