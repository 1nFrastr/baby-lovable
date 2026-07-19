import { NextResponse } from "next/server";

import { getProjectSandbox } from "@/lib/sandbox/factory";
import { normalizeWorkspacePath } from "@/lib/sandbox/protected-paths";
import {
  assertExplorerReadPath,
  looksBinaryByExtension,
  looksBinaryContent,
  truncateExplorerContent,
} from "@/lib/sandbox/workspace-explorer";
import {
  requireSessionAuth,
  SessionAccessDeniedError,
  UnauthenticatedError,
} from "@/lib/session/auth-context";
import { getSession } from "@/lib/session/store";

export async function GET(
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

  try {
    const session = await getSession(sessionId, auth);
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const url = new URL(request.url);
    const rawPath = url.searchParams.get("path");
    if (!rawPath || rawPath.trim() === "" || rawPath.trim() === ".") {
      return NextResponse.json(
        { error: "Query parameter \"path\" is required" },
        { status: 400 },
      );
    }

    const path = normalizeWorkspacePath(rawPath);
    const blocked = assertExplorerReadPath(path);
    if (blocked) {
      return NextResponse.json({ error: blocked }, { status: 403 });
    }

    if (looksBinaryByExtension(path)) {
      return NextResponse.json(
        {
          path,
          content: "",
          binary: true,
          truncated: false,
          totalLines: 0,
          shownLines: 0,
          maxLines: 0,
          maxBytes: 0,
          byteLength: 0,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const sandbox = await getProjectSandbox(
      sessionId,
      session.sandboxMode,
      auth.userId,
    );

    let details;
    try {
      details = await sandbox.fs.getFileDetails(path);
    } catch {
      details = null;
    }
    if (details?.isDir) {
      return NextResponse.json(
        { error: `"${path}" is a directory` },
        { status: 400 },
      );
    }

    const raw = await sandbox.fs.readTextFile(path);
    if (looksBinaryContent(raw)) {
      return NextResponse.json(
        {
          path,
          content: "",
          binary: true,
          truncated: false,
          totalLines: 0,
          shownLines: 0,
          maxLines: 0,
          maxBytes: 0,
          byteLength: 0,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const truncated = truncateExplorerContent(raw);

    return NextResponse.json(
      {
        path,
        binary: false,
        ...truncated,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const message =
      error instanceof Error ? error.message : "Failed to read file";
    console.error(`[files/content] session=${sessionId}`, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
