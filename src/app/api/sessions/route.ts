import { NextResponse } from "next/server";

import { createSession, listSessions } from "@/lib/session/store";

export async function GET() {
  const sessions = await listSessions();
  return NextResponse.json({ sessions });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    title?: string;
  };

  const session = await createSession({
    title: body.title,
    sandboxMode: "local",
  });

  return NextResponse.json({ session }, { status: 201 });
}
