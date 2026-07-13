import { NextResponse } from "next/server";

import {
  browserRunConfigured,
  isAppTestRunning,
  parseAppTestActions,
  readLatestAppTestStatus,
  startBackgroundAppTest,
} from "@/lib/browser-run";
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

    const latest = await readLatestAppTestStatus(sessionId, session.userId);
    const running = isAppTestRunning(sessionId);

    return NextResponse.json({
      ...latest,
      // Prefer live lock over stale file if process restarted mid-run.
      status:
        running && latest.status !== "running"
          ? "running"
          : running
            ? "running"
            : latest.status,
      browserRunConfigured: browserRunConfigured(),
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

    if (session.sandboxMode !== "daytona") {
      return NextResponse.json(
        {
          error:
            "App testing requires sandboxMode=daytona (Cloudflare cannot reach localhost).",
        },
        { status: 400 },
      );
    }

    if (!browserRunConfigured()) {
      return NextResponse.json(
        {
          error:
            "Cloudflare Browser Run is not configured. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_BROWSER_RUN_API_TOKEN.",
        },
        { status: 400 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as {
      actions?: unknown;
      holdMs?: number;
      maxClicks?: number;
    };

    let actions: ReturnType<typeof parseAppTestActions> | undefined;
    if (body.actions !== undefined) {
      try {
        actions = parseAppTestActions(body.actions);
      } catch (error) {
        return NextResponse.json(
          {
            error:
              error instanceof Error ? error.message : "Invalid actions array",
          },
          { status: 400 },
        );
      }
    }

    const holdMs =
      typeof body.holdMs === "number" && Number.isFinite(body.holdMs)
        ? Math.max(0, body.holdMs)
        : 8_000;

    const result = await startBackgroundAppTest({
      sessionId,
      holdMs,
      actions,
      maxClicks: body.maxClicks,
    });

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    const latest = await readLatestAppTestStatus(sessionId, session.userId);

    return NextResponse.json({
      status: "running" as const,
      runId: latest.runId,
      started: true,
      holdMs,
      usedScriptedActions: Boolean(actions && actions.length > 0),
    });
  } catch (error) {
    if (error instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    throw error;
  }
}
