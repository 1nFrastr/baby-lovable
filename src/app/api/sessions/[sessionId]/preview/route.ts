import { NextResponse } from "next/server";

import {
  deleteSandbox,
  getAllStatus,
  hasNodeModules,
  restartAppServer,
  startAppServer,
  stopAppServer,
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

/** Read-only: three-layer status. Never starts anything. */
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

    const all = await getAllStatus(sessionId);
    return NextResponse.json({
      sandbox: all.sandbox,
      appServer: all.appServer,
      previewUrl: all.previewUrl,
      // keep old field for existing UI during transition
      preview: all.appServer,
      sandboxMode: session.sandboxMode,
    });
  } catch (error) {
    if (error instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    throw error;
  }
}

/** Write: start or restart app server. */
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

    if (session.sandboxMode === "local") {
      const hasDeps = await hasNodeModules(sessionId);
      if (!hasDeps) {
        return NextResponse.json({
          sandbox: "running" as const,
          appServer: { status: "needs_install" as const },
          previewUrl: { status: "none" as const },
          preview: { status: "needs_install" as const },
          sandboxMode: session.sandboxMode,
        });
      }
    }

    const appServer =
      body.action === "restart"
        ? await restartAppServer(sessionId)
        : await startAppServer(sessionId);

    const all = await getAllStatus(sessionId);
    return NextResponse.json({
      sandbox: all.sandbox,
      appServer,
      previewUrl: all.previewUrl,
      preview: appServer,
      sandboxMode: session.sandboxMode,
    });
  } catch (error) {
    if (error instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    throw error;
  }
}

/**
 * Stop app server by default.
 * Pass ?deleteSandbox=1 to also delete the Daytona sandbox.
 */
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

    const deleteVm =
      new URL(request.url).searchParams.get("deleteSandbox") === "1" ||
      new URL(request.url).searchParams.get("destroy") === "1";

    if (deleteVm) {
      await deleteSandbox(sessionId);
    } else {
      await stopAppServer(sessionId);
    }

    const all = await getAllStatus(sessionId);
    return NextResponse.json({
      sandbox: all.sandbox,
      appServer: all.appServer,
      previewUrl: all.previewUrl,
      preview: all.appServer,
      sandboxMode: session.sandboxMode,
    });
  } catch (error) {
    if (error instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    throw error;
  }
}
