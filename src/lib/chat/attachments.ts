import type { FileUIPart, UIMessage } from "ai";

import {
  isPreviewPickPart,
  type PreviewElementPickPayload,
} from "@/lib/preview/bridge-protocol";
import {
  collectPreviewPickParts,
  formatPreviewPicksForPrompt,
  previewPickChipLabel,
  toPreviewPickUIPart,
} from "@/lib/preview/format-preview-pick";

/** Per-file ceiling for composer uploads (raw bytes, before base64). */
export const CHAT_ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;

/** Combined raw-byte ceiling across all files in one user message. */
export const CHAT_ATTACHMENT_MAX_TOTAL_BYTES = 4 * 1024 * 1024;

export const CHAT_ATTACHMENT_MAX_FILES = 4;

const EXT_TO_MEDIA: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
};

const ALLOWED_MEDIA_TYPES = new Set<string>([
  ...Object.values(EXT_TO_MEDIA),
  "image/jpg",
  "text/xml",
]);

const TEXT_MEDIA_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "text/xml",
  "application/json",
  "application/xml",
]);

const MAX_EXTRACTED_TEXT_CHARS = 80_000;

/** Hidden file-input `accept` list: MIME types plus extensions for empty `File.type`. */
export const CHAT_ATTACHMENT_ACCEPT = [
  ...new Set(Object.values(EXT_TO_MEDIA)),
  ...Object.keys(EXT_TO_MEDIA).map((ext) => `.${ext}`),
].join(",");

export function fileExtension(filename: string | undefined): string {
  if (!filename) {
    return "";
  }
  const base = filename.replaceAll("\\", "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) {
    return "";
  }
  return base.slice(dot + 1).toLowerCase();
}

export function mediaTypeFromFilename(
  filename: string | undefined,
): string | undefined {
  const ext = fileExtension(filename);
  return ext ? EXT_TO_MEDIA[ext] : undefined;
}

export function sanitizeAttachmentFilename(
  name: string | undefined,
): string | undefined {
  if (!name) {
    return undefined;
  }
  const base = name.replaceAll("\\", "/").split("/").pop() ?? "";
  const cleaned = base.replaceAll(/[\u0000-\u001f]/g, "").trim();
  if (!cleaned) {
    return undefined;
  }
  return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
}

export function normalizeAttachmentMediaType(
  mediaType: string | undefined,
  filename?: string,
): string | null {
  const fromName = mediaTypeFromFilename(filename);
  const raw = (mediaType ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
  const mapped = raw === "image/jpg" ? "image/jpeg" : raw;

  if (mapped && ALLOWED_MEDIA_TYPES.has(mapped)) {
    return mapped === "image/jpg" ? "image/jpeg" : mapped;
  }
  if (fromName && ALLOWED_MEDIA_TYPES.has(fromName)) {
    return fromName;
  }
  return null;
}

export function isImageMediaType(mediaType: string | undefined): boolean {
  return (mediaType ?? "").toLowerCase().startsWith("image/");
}

/** Raster images that are safe to render with `<img>` (SVG is served as a download). */
export function isRasterImageMediaType(
  mediaType: string | undefined,
): boolean {
  const normalized = (mediaType ?? "").toLowerCase().split(";")[0]?.trim();
  return (
    Boolean(normalized?.startsWith("image/")) &&
    normalized !== "image/svg+xml"
  );
}

export function attachmentSizeLimitMessage(filename?: string): string {
  const label = sanitizeAttachmentFilename(filename) ?? "File";
  return `${label} is larger than ${Math.floor(CHAT_ATTACHMENT_MAX_BYTES / (1024 * 1024))}MB.`;
}

export function attachmentCountLimitMessage(
  maxFiles = CHAT_ATTACHMENT_MAX_FILES,
): string {
  return `You can attach up to ${maxFiles} files. Some were not added.`;
}

export function attachmentTotalSizeLimitMessage(): string {
  return "Attached files are too large together. Remove some and retry.";
}

export function attachmentUnsupportedTypeMessage(filename?: string): string {
  const label = sanitizeAttachmentFilename(filename);
  return label ? `Unsupported file type: ${label}` : "Unsupported file type";
}

export type ComposerFileInput = {
  name: string;
  size: number;
  type: string;
};

export type ComposerFileFilterError = {
  code: "accept" | "max_file_size" | "max_files" | "max_total_file_size";
  message: string;
};

export type ComposerFileFilterResult = {
  acceptedIndexes: number[];
  error: ComposerFileFilterError | null;
};

/** Keep accepted files; report the first rejection so the composer can show it. */
export function filterComposerFiles(
  incoming: ComposerFileInput[],
  options: {
    currentCount: number;
    currentBytes: number;
    isAccepted: (file: ComposerFileInput) => boolean;
    maxFiles?: number;
    maxFileSize?: number;
    maxTotalBytes?: number;
  },
): ComposerFileFilterResult {
  const maxFiles = options.maxFiles ?? CHAT_ATTACHMENT_MAX_FILES;
  const maxFileSize = options.maxFileSize ?? CHAT_ATTACHMENT_MAX_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? CHAT_ATTACHMENT_MAX_TOTAL_BYTES;

  const acceptedIndexes: number[] = [];
  let count = options.currentCount;
  let bytes = options.currentBytes;
  let error: ComposerFileFilterError | null = null;

  for (const [index, file] of incoming.entries()) {
    if (!options.isAccepted(file)) {
      error ??= {
        code: "accept",
        message: attachmentUnsupportedTypeMessage(file.name),
      };
      continue;
    }
    if (file.size > maxFileSize) {
      error ??= {
        code: "max_file_size",
        message: attachmentSizeLimitMessage(file.name),
      };
      continue;
    }
    if (count >= maxFiles) {
      error ??= {
        code: "max_files",
        message: attachmentCountLimitMessage(maxFiles),
      };
      continue;
    }
    if (bytes + file.size > maxTotalBytes) {
      error ??= {
        code: "max_total_file_size",
        message: attachmentTotalSizeLimitMessage(),
      };
      continue;
    }
    acceptedIndexes.push(index);
    count += 1;
    bytes += file.size;
  }

  return { acceptedIndexes, error };
}

export function pastedAttachmentFilename(file: {
  name: string;
  type: string;
}): string {
  const cleaned = sanitizeAttachmentFilename(file.name);
  if (cleaned) {
    return cleaned;
  }
  const media = normalizeAttachmentMediaType(file.type, file.name);
  if (media?.startsWith("image/")) {
    const ext =
      media === "image/jpeg"
        ? "jpg"
        : media === "image/svg+xml"
          ? "svg"
          : media.slice("image/".length) || "png";
    const stamp = new Date()
      .toISOString()
      .replaceAll(/[:.]/g, "-")
      .replace("T", "_")
      .replace("Z", "");
    return `screenshot-${stamp}.${ext}`;
  }
  return "pasted-file";
}

export function renamePastedFile(file: File): File {
  const filename = pastedAttachmentFilename(file);
  const type =
    file.type || normalizeAttachmentMediaType("", filename) || file.type;
  if (filename === file.name && type === file.type) {
    return file;
  }
  return new File([file], filename, {
    lastModified: file.lastModified,
    type,
  });
}

export function isTextMediaType(
  mediaType: string | undefined,
  filename?: string,
): boolean {
  const normalized = normalizeAttachmentMediaType(mediaType, filename);
  return normalized != null && TEXT_MEDIA_TYPES.has(normalized);
}

export function isPdfMediaType(mediaType: string | undefined): boolean {
  return (mediaType ?? "").toLowerCase().split(";")[0]?.trim() === "application/pdf";
}

/** Persisted file-part URL. Bytes live in Storage, not in message JSON. */
export const ATTACHMENT_URL_PREFIX = "attachment://";

const ATTACHMENT_ID_RE = /^att_[A-Za-z0-9_-]+$/;

export function storedAttachmentUrl(id: string): string {
  return `${ATTACHMENT_URL_PREFIX}${id}`;
}

export function isDroppedAttachmentUrl(url: string): boolean {
  return url.trim().startsWith(`${ATTACHMENT_URL_PREFIX}dropped/`);
}

export function isStoredAttachmentId(id: string): boolean {
  return ATTACHMENT_ID_RE.test(id);
}

/**
 * Parse a stored `attachment://` URL or the host proxy path.
 * Rejects arbitrary https URLs so the model path cannot fetch attacker-controlled hosts.
 */
export function parseAttachmentId(
  url: string,
  sessionId?: string,
): string | null {
  const trimmed = url.trim();
  if (trimmed.startsWith(ATTACHMENT_URL_PREFIX)) {
    const rest = trimmed.slice(ATTACHMENT_URL_PREFIX.length);
    const id = rest.startsWith("dropped/") ? rest.slice("dropped/".length) : rest;
    return isStoredAttachmentId(id) ? id : null;
  }

  let path = trimmed;
  if (!trimmed.startsWith("/")) {
    try {
      path = new URL(trimmed).pathname;
    } catch {
      return null;
    }
  }

  const match = path.match(
    /^\/api\/sessions\/([^/]+)\/attachments\/([^/]+)$/,
  );
  if (!match) {
    return null;
  }
  const [, pathSessionId, id] = match;
  if (sessionId && pathSessionId !== sessionId) {
    return null;
  }
  return id && isStoredAttachmentId(id) ? id : null;
}

export function collectStoredAttachmentIds(messages: UIMessage[]): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const part of collectFileParts(message)) {
      const id = parseAttachmentId(part.url);
      if (id) {
        ids.add(id);
      }
    }
  }
  return [...ids];
}

/** Browser `src` for a stored attachment. `null` when the object was dropped. */
export function attachmentDisplayUrl(
  sessionId: string,
  url: string,
): string | null {
  const trimmed = url.trim();
  if (!trimmed || isDroppedAttachmentUrl(trimmed)) {
    return null;
  }
  if (trimmed.startsWith("data:") || trimmed.startsWith("blob:")) {
    return trimmed;
  }
  const id = parseAttachmentId(trimmed, sessionId);
  if (!id) {
    return null;
  }
  return `/api/sessions/${sessionId}/attachments/${id}`;
}

export function isAllowedAttachmentUrl(
  url: string,
  sessionId?: string,
): boolean {
  if (url.startsWith("data:")) {
    return true;
  }
  return parseAttachmentId(url, sessionId) != null;
}

export function omittedAttachmentText(
  filename: string | undefined,
  mediaType: string | undefined,
): string {
  const label = filename?.trim() || mediaType?.trim() || "file";
  return `[attached ${label} — omitted from older context]`;
}

/** Replace file parts on user turns older than `keepRecent` with a one-line stub. */
export function stubOlderUserFileParts(
  messages: UIMessage[],
  keepRecent: number,
): UIMessage[] {
  const keepFrom = Math.max(0, messages.length - keepRecent);
  if (keepFrom === 0) {
    return messages;
  }

  return messages.map((message, index) => {
    if (index >= keepFrom || message.role !== "user") {
      return message;
    }
    let changed = false;
    const parts: UIMessage["parts"] = [];
    for (const part of message.parts) {
      if (part.type !== "file") {
        parts.push(part);
        continue;
      }
      changed = true;
      parts.push({
        type: "text",
        text: omittedAttachmentText(part.filename, part.mediaType),
      });
    }
    return changed ? { ...message, parts } : message;
  });
}

export function estimateDataUrlBytes(url: string): number {
  if (!url.startsWith("data:")) {
    return 0;
  }
  const comma = url.indexOf(",");
  if (comma < 0) {
    return 0;
  }
  const header = url.slice(5, comma);
  const data = url.slice(comma + 1);
  if (header.toLowerCase().includes(";base64")) {
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
  }
  try {
    return decodeURIComponent(data).length;
  } catch {
    return data.length;
  }
}

export function collectFileParts(
  message: UIMessage,
): Extract<UIMessage["parts"][number], { type: "file" }>[] {
  return message.parts.filter(
    (part): part is Extract<UIMessage["parts"][number], { type: "file" }> =>
      part.type === "file",
  );
}

export function collectUserText(message: UIMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<UIMessage["parts"][number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** One-line prompt inventory for `[agent-trace]` (no attachment bytes). */
export function describeLastUserPrompt(messages: UIMessage[]): string {
  const message = [...messages]
    .reverse()
    .find((candidate) => candidate.role === "user");
  if (!message) {
    return "last-user=none";
  }
  const files = collectFileParts(message);
  const picks = collectPreviewPickParts(message.parts);
  const media = files.map((file) => file.mediaType).join(",") || "none";
  return `last-user textChars=${collectUserText(message).length} fileParts=${files.length} previewPicks=${picks.length} media=[${media}]`;
}

/** Short label for titles, git trailers, and file-only bubbles. */
export function userMessagePreview(message: UIMessage): string {
  const text = collectUserText(message);
  if (text) {
    return text;
  }
  const picks = collectPreviewPickParts(message.parts);
  if (picks.length > 0) {
    const first = picks[0];
    if (first) {
      const label = previewPickChipLabel(first.data);
      return picks.length === 1 ? label : `${label} +${picks.length - 1}`;
    }
  }
  const files = collectFileParts(message);
  if (files.length === 0) {
    return "";
  }
  const names = files.map(
    (file) => file.filename?.trim() || "Attached file",
  );
  if (names.length === 1) {
    return names[0] ?? "Attached file";
  }
  return `${names[0]} +${names.length - 1}`;
}

export function isSendableUserMessage(message: UIMessage): boolean {
  if (message.role !== "user") {
    return false;
  }
  return (
    collectUserText(message).length > 0 ||
    collectFileParts(message).length > 0 ||
    collectPreviewPickParts(message.parts).length > 0
  );
}

export function latestUserMessage(
  messages: UIMessage[],
): UIMessage | null {
  const message = [...messages]
    .reverse()
    .find((candidate) => isSendableUserMessage(candidate));
  if (!message?.id) {
    return null;
  }
  return message;
}

export function buildUserMessageParts(
  text: string,
  files: FileUIPart[] = [],
  picks: PreviewElementPickPayload[] = [],
): UIMessage["parts"] {
  const parts: UIMessage["parts"] = [];
  for (const pick of picks) {
    parts.push(toPreviewPickUIPart(pick) as UIMessage["parts"][number]);
  }
  const trimmed = text.trim();
  if (trimmed) {
    parts.push({ type: "text", text: trimmed });
  }
  for (const file of files) {
    parts.push({
      type: "file",
      mediaType: file.mediaType,
      filename: file.filename,
      url: file.url,
    });
  }
  return parts;
}

export type AttachmentValidationResult =
  | { ok: true; message: UIMessage }
  | { ok: false; error: string };

export function normalizeFilePart(
  part: Extract<UIMessage["parts"][number], { type: "file" }>,
  sessionId?: string,
): Extract<UIMessage["parts"][number], { type: "file" }> | { error: string } {
  const filename = sanitizeAttachmentFilename(part.filename);
  const mediaType = normalizeAttachmentMediaType(part.mediaType, filename);
  if (!mediaType) {
    return {
      error: filename
        ? `Unsupported file type: ${filename}`
        : "Unsupported file type",
    };
  }
  const url = part.url?.trim() ?? "";
  if (!url || !isAllowedAttachmentUrl(url, sessionId)) {
    return {
      error: filename
        ? `Could not read ${filename}. Attach the file again.`
        : "Could not read an attached file. Attach it again.",
    };
  }
  const bytes = url.startsWith("data:") ? estimateDataUrlBytes(url) : 0;
  if (bytes > CHAT_ATTACHMENT_MAX_BYTES) {
    return {
      error: `${filename ?? "File"} is larger than ${Math.floor(CHAT_ATTACHMENT_MAX_BYTES / (1024 * 1024))}MB.`,
    };
  }
  return {
    type: "file",
    mediaType,
    filename,
    url,
  };
}

/**
 * Reject or normalize file parts on a user message before claiming a turn.
 * Messages without files pass through.
 */
export function validateUserMessageAttachments(
  message: UIMessage,
  sessionId?: string,
): AttachmentValidationResult {
  const files = collectFileParts(message);
  if (files.length === 0) {
    return { ok: true, message };
  }
  if (files.length > CHAT_ATTACHMENT_MAX_FILES) {
    return {
      ok: false,
      error: `You can attach up to ${CHAT_ATTACHMENT_MAX_FILES} files.`,
    };
  }

  const normalized: Extract<UIMessage["parts"][number], { type: "file" }>[] =
    [];
  let totalBytes = 0;
  for (const file of files) {
    const next = normalizeFilePart(file, sessionId);
    if ("error" in next) {
      return { ok: false, error: next.error };
    }
    totalBytes += next.url.startsWith("data:")
      ? estimateDataUrlBytes(next.url)
      : 0;
    if (totalBytes > CHAT_ATTACHMENT_MAX_TOTAL_BYTES) {
      return {
        ok: false,
        error: "Attached files are too large together. Remove some and retry.",
      };
    }
    normalized.push(next);
  }

  let fileIndex = 0;
  const parts = message.parts.map((part) => {
    if (part.type !== "file") {
      return part;
    }
    const next = normalized[fileIndex];
    fileIndex += 1;
    return next ?? part;
  });

  return { ok: true, message: { ...message, parts } };
}

export function decodeDataUrl(
  url: string,
): { mediaType: string; bytes: Uint8Array } | null {
  if (!url.startsWith("data:")) {
    return null;
  }
  const comma = url.indexOf(",");
  if (comma < 0) {
    return null;
  }
  const header = url.slice(5, comma);
  const data = url.slice(comma + 1);
  const mediaType =
    header.split(";")[0]?.trim() || "application/octet-stream";
  try {
    if (header.toLowerCase().includes(";base64")) {
      if (typeof Buffer !== "undefined") {
        return { mediaType, bytes: new Uint8Array(Buffer.from(data, "base64")) };
      }
      const binary = atob(data);
      return {
        mediaType,
        bytes: Uint8Array.from(binary, (char) => char.charCodeAt(0)),
      };
    }
    return { mediaType, bytes: new TextEncoder().encode(decodeURIComponent(data)) };
  } catch {
    return null;
  }
}

function decodeTextDataUrl(url: string): string | null {
  const decoded = decodeDataUrl(url);
  if (!decoded) {
    return null;
  }
  return new TextDecoder().decode(decoded.bytes);
}

function formatAttachedText(filename: string | undefined, text: string): string {
  const label = filename?.trim() || "attached file";
  const truncated =
    text.length > MAX_EXTRACTED_TEXT_CHARS
      ? `${text.slice(0, MAX_EXTRACTED_TEXT_CHARS)}\n…[truncated ${text.length - MAX_EXTRACTED_TEXT_CHARS} chars]`
      : text;
  return `Attached file \`${label}\`:\n\`\`\`\n${truncated}\n\`\`\``;
}

function formatByteSize(byteSize: number): string {
  if (byteSize <= 0) {
    return "";
  }
  if (byteSize < 1024) {
    return ` · ${byteSize} bytes`;
  }
  return ` · ${Math.round(byteSize / 1024)} KB`;
}

function formatAttachedPdf(
  filename: string | undefined,
  byteSize: number,
): string {
  const label = filename?.trim() || "document.pdf";
  return `Attached PDF \`${label}\`${formatByteSize(byteSize)}. PDF pages are not rendered in this prompt — only this filename and size are visible.`;
}

function formatAttachedBinary(
  filename: string | undefined,
  mediaType: string | undefined,
  byteSize: number,
): string {
  const label = filename?.trim() || mediaType?.trim() || "attached file";
  return `Attached file \`${label}\` (${mediaType ?? "unknown"}${formatByteSize(byteSize)}). This type is not inlined into the prompt.`;
}

/**
 * Model-facing copy of UI messages: decode text documents into prompt text
 * (widely supported) and leave raster images as file parts for vision models.
 *
 * PDFs and other non-image binaries must not stay as `file` parts: GLM / the
 * gateway can drop the entire user turn when it sees an unsupported media type,
 * including the user's text sitting next to a PDF.
 */
export function expandAttachmentPartsForModel(
  messages: UIMessage[],
): UIMessage[] {
  return messages.map((message) => {
    if (message.role !== "user") {
      return message;
    }

    const extracted: string[] = [];
    const pickBlocks: string[] = [];
    const parts: UIMessage["parts"] = [];
    for (const part of message.parts) {
      if (isPreviewPickPart(part)) {
        const block = formatPreviewPicksForPrompt([part.data]);
        if (block) {
          pickBlocks.push(block);
        }
        continue;
      }
      if (part.type !== "file") {
        parts.push(part);
        continue;
      }
      if (isTextMediaType(part.mediaType, part.filename)) {
        const text = decodeTextDataUrl(part.url);
        if (text && text.trim()) {
          extracted.push(formatAttachedText(part.filename, text));
          continue;
        }
      }
      if (!part.url.startsWith("data:")) {
        parts.push({
          type: "text",
          text: omittedAttachmentText(part.filename, part.mediaType),
        });
        continue;
      }
      if (isPdfMediaType(part.mediaType)) {
        extracted.push(
          formatAttachedPdf(part.filename, estimateDataUrlBytes(part.url)),
        );
        continue;
      }
      if (!isRasterImageMediaType(part.mediaType)) {
        extracted.push(
          formatAttachedBinary(
            part.filename,
            part.mediaType,
            estimateDataUrlBytes(part.url),
          ),
        );
        continue;
      }
      parts.push(part);
    }

    if (pickBlocks.length > 0) {
      const pickText = pickBlocks.join("\n\n");
      const textIndex = parts.findIndex((part) => part.type === "text");
      if (textIndex >= 0) {
        const current = parts[textIndex];
        if (current?.type === "text") {
          parts[textIndex] = {
            type: "text",
            text: `${pickText}\n\n${current.text.trim()}`,
          };
        }
      } else {
        parts.unshift({ type: "text", text: pickText });
      }
    }

    if (extracted.length === 0) {
      return { ...message, parts };
    }

    const extra = extracted.join("\n\n");
    const textIndex = parts.findIndex((part) => part.type === "text");
    if (textIndex >= 0) {
      const current = parts[textIndex];
      if (current?.type === "text") {
        parts[textIndex] = {
          type: "text",
          text: `${current.text.trim()}\n\n${extra}`,
        };
      }
    } else {
      parts.unshift({ type: "text", text: extra });
    }

    return { ...message, parts };
  });
}

/**
 * Upload composer files (blob or data URLs) to Storage. The chat POST then
 * carries `attachment://` URLs only.
 */
export async function uploadSessionAttachments(
  sessionId: string,
  files: FileUIPart[],
): Promise<FileUIPart[]> {
  if (files.length === 0) {
    return [];
  }

  const form = new FormData();
  for (const file of files) {
    const response = await fetch(file.url);
    if (!response.ok) {
      throw new Error(
        file.filename
          ? `Could not read ${file.filename}. Attach the file again.`
          : "Could not read an attached file. Attach it again.",
      );
    }
    const blob = await response.blob();
    form.append(
      "file",
      new File([blob], file.filename ?? "file", {
        type: file.mediaType || blob.type,
      }),
    );
  }

  const response = await fetch(`/api/sessions/${sessionId}/attachments`, {
    method: "POST",
    body: form,
  });
  const data = (await response.json().catch(() => null)) as
    | { error?: string; files?: FileUIPart[] }
    | null;
  if (!response.ok) {
    throw new Error(data?.error ?? `Upload failed (${response.status})`);
  }
  if (!data?.files || data.files.length !== files.length) {
    throw new Error("Upload did not return every attached file.");
  }
  return data.files;
}
