import { generateId, type FileUIPart, type UIMessage } from "ai";

import { getSupabaseAdminClient } from "@/lib/supabase/admin";

import {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_FILES,
  CHAT_ATTACHMENT_MAX_TOTAL_BYTES,
  collectFileParts,
  decodeDataUrl,
  expandAttachmentPartsForModel,
  isDroppedAttachmentUrl,
  normalizeAttachmentMediaType,
  normalizeFilePart,
  omittedAttachmentText,
  parseAttachmentId,
  sanitizeAttachmentFilename,
  storedAttachmentUrl,
  type AttachmentValidationResult,
} from "./attachments";

export const CHAT_ATTACHMENT_BUCKET = "chat-attachments";

export interface SessionAttachmentRow {
  id: string;
  session_id: string;
  user_id: string;
  message_id: string | null;
  storage_path: string;
  media_type: string;
  filename: string | null;
  byte_size: number;
  created_at: string;
  dropped_at: string | null;
}

function storageFilename(filename: string | undefined): string {
  const cleaned = sanitizeAttachmentFilename(filename) ?? "file";
  const safe = cleaned.replaceAll(/[^A-Za-z0-9._-]/g, "_");
  return safe || "file";
}

export function attachmentStoragePath(input: {
  userId: string;
  sessionId: string;
  attachmentId: string;
  filename?: string;
}): string {
  return `${input.userId}/${input.sessionId}/${input.attachmentId}/${storageFilename(input.filename)}`;
}

function bytesToDataUrl(mediaType: string, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}

async function getAttachmentRow(
  sessionId: string,
  attachmentId: string,
): Promise<SessionAttachmentRow | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("session_attachments")
    .select("*")
    .eq("session_id", sessionId)
    .eq("id", attachmentId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load attachment: ${error.message}`);
  }
  return (data as SessionAttachmentRow | null) ?? null;
}

export async function downloadSessionAttachment(input: {
  sessionId: string;
  userId: string;
  attachmentId: string;
}): Promise<
  | { ok: true; row: SessionAttachmentRow; bytes: Uint8Array }
  | { ok: false; status: 404 | 410 | 403; error: string }
> {
  const row = await getAttachmentRow(input.sessionId, input.attachmentId);
  if (!row) {
    return { ok: false, status: 404, error: "Attachment not found" };
  }
  if (row.user_id !== input.userId) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  if (row.dropped_at) {
    return { ok: false, status: 410, error: "Attachment was removed" };
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase.storage
    .from(CHAT_ATTACHMENT_BUCKET)
    .download(row.storage_path);
  if (error || !data) {
    return { ok: false, status: 404, error: "Attachment not found" };
  }

  return {
    ok: true,
    row,
    bytes: new Uint8Array(await data.arrayBuffer()),
  };
}

export async function uploadSessionAttachmentBytes(input: {
  sessionId: string;
  userId: string;
  messageId?: string | null;
  mediaType: string;
  filename?: string;
  bytes: Uint8Array;
}): Promise<FileUIPart> {
  if (input.bytes.byteLength > CHAT_ATTACHMENT_MAX_BYTES) {
    throw new Error(
      `${input.filename ?? "File"} is larger than ${Math.floor(CHAT_ATTACHMENT_MAX_BYTES / (1024 * 1024))}MB.`,
    );
  }

  const mediaType = normalizeAttachmentMediaType(
    input.mediaType,
    input.filename,
  );
  if (!mediaType) {
    throw new Error(
      input.filename
        ? `Unsupported file type: ${input.filename}`
        : "Unsupported file type",
    );
  }

  const id = `att_${generateId()}`;
  const storagePath = attachmentStoragePath({
    userId: input.userId,
    sessionId: input.sessionId,
    attachmentId: id,
    filename: input.filename,
  });
  const supabase = getSupabaseAdminClient();
  const { error: uploadError } = await supabase.storage
    .from(CHAT_ATTACHMENT_BUCKET)
    .upload(storagePath, input.bytes, {
      contentType: mediaType,
      upsert: false,
    });
  if (uploadError) {
    throw new Error(`Failed to store attachment: ${uploadError.message}`);
  }

  const { error: insertError } = await supabase.from("session_attachments").insert({
    id,
    session_id: input.sessionId,
    user_id: input.userId,
    message_id: input.messageId ?? null,
    storage_path: storagePath,
    media_type: mediaType,
    filename: sanitizeAttachmentFilename(input.filename) ?? null,
    byte_size: input.bytes.byteLength,
  });
  if (insertError) {
    await supabase.storage.from(CHAT_ATTACHMENT_BUCKET).remove([storagePath]);
    throw new Error(`Failed to record attachment: ${insertError.message}`);
  }

  return {
    type: "file",
    mediaType,
    filename: sanitizeAttachmentFilename(input.filename),
    url: storedAttachmentUrl(id),
  };
}

async function bindAttachmentToMessage(
  sessionId: string,
  attachmentId: string,
  messageId: string,
): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase
    .from("session_attachments")
    .update({ message_id: messageId })
    .eq("id", attachmentId)
    .eq("session_id", sessionId)
    .is("dropped_at", null);
  if (error) {
    throw new Error(`Failed to bind attachment: ${error.message}`);
  }
}

/**
 * Move data-URL bytes into Storage and rewrite file parts to `attachment://`.
 * Existing stored URLs are verified against this session.
 */
export async function persistUserMessageAttachments(input: {
  sessionId: string;
  userId: string;
  message: UIMessage;
}): Promise<AttachmentValidationResult> {
  const files = collectFileParts(input.message);
  if (files.length === 0) {
    return { ok: true, message: input.message };
  }
  if (files.length > CHAT_ATTACHMENT_MAX_FILES) {
    return {
      ok: false,
      error: `You can attach up to ${CHAT_ATTACHMENT_MAX_FILES} files.`,
    };
  }

  const nextFiles: Extract<UIMessage["parts"][number], { type: "file" }>[] =
    [];
  let totalBytes = 0;

  for (const file of files) {
    const normalized = normalizeFilePart(file, input.sessionId);
    if ("error" in normalized) {
      return { ok: false, error: normalized.error };
    }

    if (normalized.url.startsWith("data:")) {
      const decoded = decodeDataUrl(normalized.url);
      if (!decoded) {
        return {
          ok: false,
          error: normalized.filename
            ? `Could not read ${normalized.filename}. Attach the file again.`
            : "Could not read an attached file. Attach it again.",
        };
      }
      totalBytes += decoded.bytes.byteLength;
      if (totalBytes > CHAT_ATTACHMENT_MAX_TOTAL_BYTES) {
        return {
          ok: false,
          error: "Attached files are too large together. Remove some and retry.",
        };
      }
      try {
        const stored = await uploadSessionAttachmentBytes({
          sessionId: input.sessionId,
          userId: input.userId,
          messageId: input.message.id,
          mediaType: normalized.mediaType,
          filename: normalized.filename,
          bytes: decoded.bytes,
        });
        nextFiles.push(stored);
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "Could not store an attached file.",
        };
      }
      continue;
    }

    const attachmentId = parseAttachmentId(normalized.url, input.sessionId);
    if (!attachmentId || isDroppedAttachmentUrl(normalized.url)) {
      return {
        ok: false,
        error: normalized.filename
          ? `Could not read ${normalized.filename}. Attach the file again.`
          : "Could not read an attached file. Attach it again.",
      };
    }

    const row = await getAttachmentRow(input.sessionId, attachmentId);
    if (!row || row.user_id !== input.userId || row.dropped_at) {
      return {
        ok: false,
        error: normalized.filename
          ? `Could not read ${normalized.filename}. Attach the file again.`
          : "Could not read an attached file. Attach it again.",
      };
    }
    totalBytes += row.byte_size;
    if (totalBytes > CHAT_ATTACHMENT_MAX_TOTAL_BYTES) {
      return {
        ok: false,
        error: "Attached files are too large together. Remove some and retry.",
      };
    }
    if (input.message.id && row.message_id !== input.message.id) {
      await bindAttachmentToMessage(
        input.sessionId,
        attachmentId,
        input.message.id,
      );
    }
    nextFiles.push({
      type: "file",
      mediaType: row.media_type,
      filename: row.filename ?? normalized.filename,
      url: storedAttachmentUrl(row.id),
    });
  }

  let fileIndex = 0;
  const parts = input.message.parts.map((part) => {
    if (part.type !== "file") {
      return part;
    }
    const next = nextFiles[fileIndex];
    fileIndex += 1;
    return next ?? part;
  });

  return { ok: true, message: { ...input.message, parts } };
}

async function materializeStoredFileParts(
  sessionId: string,
  message: UIMessage,
): Promise<UIMessage> {
  if (message.role !== "user") {
    return message;
  }

  const parts: UIMessage["parts"] = [];
  let changed = false;
  for (const part of message.parts) {
    if (part.type !== "file") {
      parts.push(part);
      continue;
    }
    if (part.url.startsWith("data:")) {
      parts.push(part);
      continue;
    }

    const attachmentId = parseAttachmentId(part.url, sessionId);
    if (!attachmentId) {
      changed = true;
      parts.push({
        type: "text",
        text: omittedAttachmentText(part.filename, part.mediaType),
      });
      continue;
    }

    const row = await getAttachmentRow(sessionId, attachmentId);
    if (!row || row.dropped_at) {
      changed = true;
      parts.push({
        type: "text",
        text: omittedAttachmentText(part.filename, part.mediaType),
      });
      continue;
    }

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase.storage
      .from(CHAT_ATTACHMENT_BUCKET)
      .download(row.storage_path);
    if (error || !data) {
      changed = true;
      parts.push({
        type: "text",
        text: omittedAttachmentText(part.filename, part.mediaType),
      });
      continue;
    }

    changed = true;
    const bytes = new Uint8Array(await data.arrayBuffer());
    parts.push({
      type: "file",
      mediaType: row.media_type,
      filename: row.filename ?? part.filename,
      url: bytesToDataUrl(row.media_type, bytes),
    });
  }

  return changed ? { ...message, parts } : message;
}

/**
 * Prompt copy: download Storage bytes for user file parts still in the
 * prompt view, then inline text documents and PDF filenames. Raster images
 * stay as file parts. Sealed/summarized turns are already removed by
 * `toPromptUiMessages`.
 */
export async function hydrateAndExpandAttachmentsForModel(
  sessionId: string,
  messages: UIMessage[],
): Promise<UIMessage[]> {
  const hydrated = await Promise.all(
    messages.map((message) => materializeStoredFileParts(sessionId, message)),
  );
  return expandAttachmentPartsForModel(hydrated);
}
