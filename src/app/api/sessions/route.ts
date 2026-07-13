import { NextResponse } from "next/server";

import {
  getSessionAuthContext,
  SessionAccessDeniedError,
} from "@/lib/session/auth-context";
import { createSession, listSessions } from "@/lib/session/store";

export async function GET(request: Request) {
  const auth = await getSessionAuthContext(request);
  const sessions = await listSessions(auth);
  return NextResponse.json({ sessions });
}

export async function POST(request: Request) {
  const auth = await getSessionAuthContext(request);

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
