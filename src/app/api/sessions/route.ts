import { NextResponse } from "next/server";

import { isDaytonaConfigured } from "@/lib/sandbox/daytona/config";
import { getDefaultSandboxMode } from "@/lib/sandbox/types";
import {
  requireSessionAuth,
  SessionAccessDeniedError,
  UnauthenticatedError,
} from "@/lib/session/auth-context";
import { createSession, listSessions } from "@/lib/session/store";

export async function GET(request: Request) {
  try {
    const auth = await requireSessionAuth(request);
    const sessions = await listSessions(auth);
    const sandboxMode = getDefaultSandboxMode();
    return NextResponse.json({
      sessions,
      features: {
        daytona: isDaytonaConfigured(),
        sandboxMode,
      },
    });
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw error;
  }
}

export async function POST(request: Request) {
  let auth;
  try {
    auth = await requireSessionAuth(request);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw error;
  }

  const body = (await request.json().catch(() => ({}))) as {
    title?: string;
  };

  const sandboxMode = getDefaultSandboxMode();

  if (sandboxMode === "daytona" && !isDaytonaConfigured()) {
    return NextResponse.json(
      {
        error:
          "BABY_LOVABLE_SANDBOX_MODE=daytona but Daytona is not configured. Set DAYTONA_API_KEY (or DAYTONA_JWT_TOKEN).",
      },
      { status: 400 },
    );
  }

  try {
    const session = await createSession(
      {
        title: body.title,
        sandboxMode,
      },
      auth,
    );

    return NextResponse.json({ session }, { status: 201 });
  } catch (error) {
    if (error instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    throw error;
  }
}
