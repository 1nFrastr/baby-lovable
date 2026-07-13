import { NextResponse } from "next/server";

import {
  ensureDevServer,
  getPreviewStatus,
  hasNodeModules,
  restartDevServer,
  resolvePreviewStatus,
  stopDevServer,
} from "@/lib/sandbox/preview";
import {
  requireSessionAuth,
  SessionAccessDeniedError,
  UnauthenticatedError,
} from "@/lib/session/auth-context";
import { getSession } from "@/lib/session/store";

async function resolveAuth(request: Request) {
  try {
    return await requireSessionAuth(request);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw error;
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const auth = await resolveAuth(request);
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const session = await getSession(sessionId, auth);

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const preview = await resolvePreviewStatus(sessionId);
    return NextResponse.json({
      preview,
      sandboxMode: session.sandboxMode,
    });
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
  const auth = await resolveAuth(request);
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const session = await getSession(sessionId, auth);

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      action?: "start" | "restart";
    };

    // Local: require node_modules before start (bootstrap installs via GET poll).
    // Daytona: ensureDevServer/restart handles remote install during bootstrap.
    if (session.sandboxMode === "local") {
      const hasDeps = await hasNodeModules(sessionId);
      if (!hasDeps) {
        return NextResponse.json({
          preview: { status: "needs_install" as const },
          sandboxMode: session.sandboxMode,
        });
      }
    }

    const preview =
      body.action === "restart"
        ? await restartDevServer(sessionId)
        : await ensureDevServer(sessionId);

    return NextResponse.json({
      preview,
      sandboxMode: session.sandboxMode,
    });
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
  const auth = await resolveAuth(request);
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const session = await getSession(sessionId, auth);

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    await stopDevServer(sessionId);
    const preview = await getPreviewStatus(sessionId);
    return NextResponse.json({
      preview,
      sandboxMode: session.sandboxMode,
    });
  } catch (error) {
    if (error instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    throw error;
  }
}
