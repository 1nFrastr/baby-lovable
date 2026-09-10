import { NextResponse } from "next/server";

import { isRasterImageMediaType, isStoredAttachmentId } from "@/lib/chat/attachments";
import { downloadSessionAttachment } from "@/lib/chat/attachment-storage";
import {
  requireSessionAuth,
  SessionAccessDeniedError,
  UnauthenticatedError,
  assertSessionOwner,
} from "@/lib/session/auth-context";
import { getSessionOwner } from "@/lib/session/store";

function jsonError(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

function contentDisposition(filename: string | null, inline: boolean): string {
  const fallback = filename?.replaceAll(/[^\x20-\x7E]/g, "_") || "file";
  const type = inline ? "inline" : "attachment";
  if (!filename) {
    return `${type}; filename="${fallback}"`;
  }
  const encoded = encodeURIComponent(filename);
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function GET(
  request: Request,
  {
    params,
  }: { params: Promise<{ sessionId: string; attachmentId: string }> },
) {
  const { sessionId, attachmentId } = await params;
  let auth;
  try {
    auth = await requireSessionAuth(request);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return jsonError("Unauthorized", 401);
    }
    throw error;
  }

  if (!isStoredAttachmentId(attachmentId)) {
    return jsonError("Attachment not found", 404);
  }

  try {
    const owner = await getSessionOwner(sessionId);
    if (!owner?.userId) {
      return jsonError("Session not found", 404);
    }
    assertSessionOwner(owner.userId, auth);

    const result = await downloadSessionAttachment({
      sessionId,
      userId: owner.userId,
      attachmentId,
    });
    if (!result.ok) {
      return jsonError(result.error, result.status);
    }

    const inline = isRasterImageMediaType(result.row.media_type);
    return new NextResponse(Buffer.from(result.bytes), {
      headers: {
        "Content-Type": result.row.media_type,
        "Content-Disposition": contentDisposition(
          result.row.filename,
          inline,
        ),
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof SessionAccessDeniedError) {
      return jsonError("Forbidden", 403);
    }
    const message =
      error instanceof Error ? error.message : "Failed to load attachment";
    return jsonError(message, 500);
  }
}
