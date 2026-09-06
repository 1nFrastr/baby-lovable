import { NextResponse } from "next/server";

import { getProjectSandbox } from "@/lib/sandbox/factory";
import { normalizeWorkspacePath } from "@/lib/sandbox/protected-paths";
import type { ProjectSandbox } from "@/lib/sandbox/types";
import {
  EXPLORER_MAX_IMAGE_BYTES,
  assertExplorerReadPath,
  explorerImageMimeType,
  explorerImageResult,
  explorerUnsupportedBinaryResult,
  looksBinaryByExtension,
  looksBinaryContent,
  looksSvgByExtension,
  truncateExplorerContent,
} from "@/lib/sandbox/workspace-explorer";
import {
  requireSessionAuth,
  SessionAccessDeniedError,
  UnauthenticatedError,
} from "@/lib/session/auth-context";
import { getSession } from "@/lib/session/store";

function jsonNoStore(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function readExplorerImage(
  sandbox: ProjectSandbox,
  path: string,
  mimeType: string,
) {
  let details;
  try {
    details = await sandbox.fs.getFileDetails(path);
  } catch {
    details = null;
  }
  if (details?.isDir) {
    return jsonNoStore({ error: `"${path}" is a directory` }, 400);
  }

  const encoding = looksSvgByExtension(path) ? "utf8" : "base64";
  const knownSize = details?.size ?? 0;
  if (knownSize > EXPLORER_MAX_IMAGE_BYTES) {
    return jsonNoStore(
      explorerImageResult({
        path,
        mimeType,
        encoding,
        content: "",
        byteLength: knownSize,
        truncated: true,
      }),
    );
  }

  if (encoding === "utf8") {
    const raw = await sandbox.fs.readTextFile(path);
    const byteLength = new TextEncoder().encode(raw).byteLength;
    if (byteLength > EXPLORER_MAX_IMAGE_BYTES) {
      return jsonNoStore(
        explorerImageResult({
          path,
          mimeType,
          encoding,
          content: "",
          byteLength,
          truncated: true,
        }),
      );
    }
    return jsonNoStore(
      explorerImageResult({
        path,
        mimeType,
        encoding,
        content: raw,
        byteLength,
      }),
    );
  }

  const bytes = await sandbox.fs.readBinaryFile(path);
  if (bytes.byteLength > EXPLORER_MAX_IMAGE_BYTES) {
    return jsonNoStore(
      explorerImageResult({
        path,
        mimeType,
        encoding,
        content: "",
        byteLength: bytes.byteLength,
        truncated: true,
      }),
    );
  }

  return jsonNoStore(
    explorerImageResult({
      path,
      mimeType,
      encoding,
      content: Buffer.from(bytes).toString("base64"),
      byteLength: bytes.byteLength,
    }),
  );
}

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
      return jsonNoStore(explorerUnsupportedBinaryResult(path));
    }

    const sandbox = await getProjectSandbox(sessionId);
    const imageMime = explorerImageMimeType(path);
    if (imageMime) {
      return readExplorerImage(sandbox, path, imageMime);
    }

    let details;
    try {
      details = await sandbox.fs.getFileDetails(path);
    } catch {
      details = null;
    }
    if (details?.isDir) {
      return jsonNoStore({ error: `"${path}" is a directory` }, 400);
    }

    const raw = await sandbox.fs.readTextFile(path);
    if (looksBinaryContent(raw)) {
      return jsonNoStore(explorerUnsupportedBinaryResult(path));
    }

    const truncated = truncateExplorerContent(raw);

    return jsonNoStore({
      path,
      kind: "text",
      binary: false,
      ...truncated,
    });
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
