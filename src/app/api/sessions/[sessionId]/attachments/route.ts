import { NextResponse } from "next/server";

import {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_FILES,
  CHAT_ATTACHMENT_MAX_TOTAL_BYTES,
  normalizeAttachmentMediaType,
  sanitizeAttachmentFilename,
} from "@/lib/chat/attachments";
import { uploadSessionAttachmentBytes } from "@/lib/chat/attachment-storage";
import {
  requireSessionAuth,
  SessionAccessDeniedError,
  UnauthenticatedError,
} from "@/lib/session/auth-context";
import { getSession } from "@/lib/session/store";

export const maxDuration = 60;

function jsonError(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

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
      return jsonError("Unauthorized", 401);
    }
    throw error;
  }

  try {
    const session = await getSession(sessionId, auth);
    if (!session) {
      return jsonError("Session not found", 404);
    }

    if (!session.userId) {
      return jsonError("Session not found", 404);
    }

    const form = await request.formData();
    const files = form
      .getAll("file")
      .filter((entry): entry is File => entry instanceof File);
    if (files.length === 0) {
      return jsonError("Attach at least one file.", 400);
    }
    if (files.length > CHAT_ATTACHMENT_MAX_FILES) {
      return jsonError(
        `You can attach up to ${CHAT_ATTACHMENT_MAX_FILES} files.`,
        400,
      );
    }

    let totalBytes = 0;
    const stored = [];
    for (const file of files) {
      const filename = sanitizeAttachmentFilename(file.name);
      const mediaType = normalizeAttachmentMediaType(file.type, filename);
      if (!mediaType) {
        return jsonError(
          filename
            ? `Unsupported file type: ${filename}`
            : "Unsupported file type",
          400,
        );
      }
      if (file.size > CHAT_ATTACHMENT_MAX_BYTES) {
        return jsonError(
          `${filename ?? "File"} is larger than ${Math.floor(CHAT_ATTACHMENT_MAX_BYTES / (1024 * 1024))}MB.`,
          400,
        );
      }
      totalBytes += file.size;
      if (totalBytes > CHAT_ATTACHMENT_MAX_TOTAL_BYTES) {
        return jsonError(
          "Attached files are too large together. Remove some and retry.",
          400,
        );
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      stored.push(
        await uploadSessionAttachmentBytes({
          sessionId,
          userId: session.userId,
          mediaType,
          filename,
          bytes,
        }),
      );
    }

    return NextResponse.json({ files: stored });
  } catch (error) {
    if (error instanceof SessionAccessDeniedError) {
      return jsonError("Forbidden", 403);
    }
    const message =
      error instanceof Error ? error.message : "Failed to upload files";
    return jsonError(message, 500);
  }
}
