import { NextResponse } from "next/server";

import { executeSlashCommand } from "@/lib/chat/run-slash-command";
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

  let command = "";
  let args = "";
  try {
    const body = (await request.json()) as {
      command?: unknown;
      args?: unknown;
    };
    if (typeof body.command === "string") {
      command = body.command.trim();
    }
    if (typeof body.args === "string") {
      args = body.args.trim();
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!command) {
    return NextResponse.json(
      { error: "A command name is required" },
      { status: 400 },
    );
  }

  try {
    const result = await executeSlashCommand({
      sessionId,
      name: command,
      args,
      auth,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, code: result.code },
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
