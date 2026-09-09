import type { FileUIPart, UIMessage } from "ai";

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

export function isTextMediaType(
  mediaType: string | undefined,
  filename?: string,
): boolean {
  const normalized = normalizeAttachmentMediaType(mediaType, filename);
  return normalized != null && TEXT_MEDIA_TYPES.has(normalized);
}

export function isAllowedAttachmentUrl(url: string): boolean {
  return url.startsWith("data:") || url.startsWith("https://");
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

/** Short label for titles, git trailers, and file-only bubbles. */
export function userMessagePreview(message: UIMessage): string {
  const text = collectUserText(message);
  if (text) {
    return text;
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
    collectUserText(message).length > 0 || collectFileParts(message).length > 0
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
): UIMessage["parts"] {
  const parts: UIMessage["parts"] = [];
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

function normalizeFilePart(
  part: Extract<UIMessage["parts"][number], { type: "file" }>,
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
  if (!url || !isAllowedAttachmentUrl(url)) {
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
    const next = normalizeFilePart(file);
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

function decodeTextDataUrl(url: string): string | null {
  if (!url.startsWith("data:")) {
    return null;
  }
  const comma = url.indexOf(",");
  if (comma < 0) {
    return null;
  }
  const header = url.slice(5, comma);
  const data = url.slice(comma + 1);
  try {
    if (header.toLowerCase().includes(";base64")) {
      return decodeBase64Utf8(data);
    }
    return decodeURIComponent(data);
  } catch {
    return null;
  }
}

function decodeBase64Utf8(data: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(data, "base64").toString("utf8");
  }
  const binary = atob(data);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function formatAttachedText(filename: string | undefined, text: string): string {
  const label = filename?.trim() || "attached file";
  const truncated =
    text.length > MAX_EXTRACTED_TEXT_CHARS
      ? `${text.slice(0, MAX_EXTRACTED_TEXT_CHARS)}\n…[truncated ${text.length - MAX_EXTRACTED_TEXT_CHARS} chars]`
      : text;
  return `Attached file \`${label}\`:\n\`\`\`\n${truncated}\n\`\`\``;
}

/**
 * Model-facing copy of UI messages: decode text documents into prompt text
 * (widely supported) and leave images/PDFs as file parts for vision models.
 */
export function expandAttachmentPartsForModel(
  messages: UIMessage[],
): UIMessage[] {
  return messages.map((message) => {
    if (message.role !== "user") {
      return message;
    }

    const extracted: string[] = [];
    const parts: UIMessage["parts"] = [];
    for (const part of message.parts) {
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
      parts.push(part);
    }

    if (extracted.length === 0) {
      return parts === message.parts ? message : { ...message, parts };
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
