import { NextResponse } from "next/server";

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
    return NextResponse.json({ sessions });
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

  try {
    const session = await createSession(
      {
        title: body.title,
        sandboxMode: "local",
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
