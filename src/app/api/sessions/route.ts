import { after } from "next/server";
import { NextResponse } from "next/server";

import { assertFreestyleForDaytona } from "@/lib/git/freestyle-config";
import { isDaytonaConfigured } from "@/lib/sandbox/daytona/config";
import { assertSupabaseMetadataConfigured } from "@/lib/supabase/config";
import { awaitRuntimeDesired } from "@/lib/sandbox/preview";
import {
  requireSessionAuth,
  SessionAccessDeniedError,
  UnauthenticatedError,
} from "@/lib/session/auth-context";
import { createSession, listSessions } from "@/lib/session/store";

/** Cover Freestyle provision + Daytona create under after() after session row exists. */
export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    assertSupabaseMetadataConfigured();
    const auth = await requireSessionAuth(request);
    const sessions = await listSessions(auth);
    return NextResponse.json({ sessions });
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    assertSupabaseMetadataConfigured();
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }

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

  if (!isDaytonaConfigured()) {
    return NextResponse.json(
      {
        error:
          "Daytona is not configured. Set DAYTONA_API_KEY (or DAYTONA_JWT_TOKEN).",
      },
      { status: 400 },
    );
  }

  try {
    assertFreestyleForDaytona();
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "FREESTYLE_API_KEY is required for Daytona sessions",
      },
      { status: 400 },
    );
  }

  try {
    const session = await createSession(
      {
        title: body.title,
      },
      auth,
    );

    // Create is metadata-only. Freestyle provision + Daytona warm run after the
    // response so "New Project" is not blocked on git/VM (UI already shows
    // preparing; hydrate still calls ensureFreestyleRepository if needed).
    after(async () => {
      const provision = (async () => {
        try {
          const { kickFreestyleProvisionWorkflow } = await import(
            "@/workflow/git-provision-kick"
          );
          await kickFreestyleProvisionWorkflow(session.id, session.userId);
        } catch (error) {
          console.warn(
            `[sessions] freestyle provision kick failed session=${session.id}:`,
            error instanceof Error ? error.message : error,
          );
        }
      })();
      await Promise.all([
        provision,
        awaitRuntimeDesired(session.id, "sandbox-ready"),
      ]);
    });

    return NextResponse.json({ session }, { status: 201 });
  } catch (error) {
    if (error instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    throw error;
  }
}
