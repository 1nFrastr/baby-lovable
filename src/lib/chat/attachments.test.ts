import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";

import {
  buildUserMessageParts,
  CHAT_ATTACHMENT_MAX_FILES,
  collectFileParts,
  estimateDataUrlBytes,
  expandAttachmentPartsForModel,
  isSendableUserMessage,
  latestUserMessage,
  normalizeAttachmentMediaType,
  userMessagePreview,
  validateUserMessageAttachments,
} from "./attachments";
import { createCompactionNail } from "./compaction";
import { isEmptyUiMessage } from "./repair-messages";

function dataUrl(mediaType: string, text: string): string {
  const base64 = Buffer.from(text, "utf8").toString("base64");
  return `data:${mediaType};base64,${base64}`;
}

function user(parts: UIMessage["parts"], id = "u1"): UIMessage {
  return { id, role: "user", parts };
}

describe("attachment media types", () => {
  it("maps extensions when MIME is missing or generic", () => {
    expect(normalizeAttachmentMediaType("", "mockup.PNG")).toBe("image/png");
    expect(normalizeAttachmentMediaType("application/octet-stream", "a.md")).toBe(
      "text/markdown",
    );
    expect(normalizeAttachmentMediaType("image/jpg", "x.jpg")).toBe("image/jpeg");
  });

  it("rejects unsupported types", () => {
    expect(normalizeAttachmentMediaType("application/zip", "a.zip")).toBeNull();
    expect(normalizeAttachmentMediaType("text/javascript", "x.js")).toBeNull();
  });
});

describe("user message helpers", () => {
  it("treats file-only rows as sendable", () => {
    const message = user([
      {
        type: "file",
        mediaType: "image/png",
        filename: "shot.png",
        url: dataUrl("image/png", "png"),
      },
    ]);
    expect(isEmptyUiMessage(message)).toBe(false);
    expect(isSendableUserMessage(message)).toBe(true);
    expect(userMessagePreview(message)).toBe("shot.png");
  });

  it("prefers text for titles and lists extra files", () => {
    expect(
      userMessagePreview(
        user([{ type: "text", text: "  Make this a landing page  " }]),
      ),
    ).toBe("Make this a landing page");
    expect(
      userMessagePreview(
        user([
          {
            type: "file",
            mediaType: "image/png",
            filename: "a.png",
            url: "https://cdn.example/a.png",
          },
          {
            type: "file",
            mediaType: "application/pdf",
            filename: "brief.pdf",
            url: "https://cdn.example/brief.pdf",
          },
        ]),
      ),
    ).toBe("a.png +1");
  });

  it("skips compaction nails when finding the latest user turn", () => {
    const nail = createCompactionNail({ turnId: "t1", auto: true });
    const real = user([{ type: "text", text: "add color" }], "u2");
    expect(latestUserMessage([real, nail])?.id).toBe("u2");
    expect(isSendableUserMessage(nail)).toBe(false);
  });

  it("builds parts with optional text", () => {
    expect(buildUserMessageParts("  hello  ", [])).toEqual([
      { type: "text", text: "hello" },
    ]);
    expect(buildUserMessageParts("", [])).toEqual([]);
    expect(
      buildUserMessageParts("", [
        {
          type: "file",
          mediaType: "image/png",
          filename: "a.png",
          url: "https://cdn.example/a.png",
        },
      ]),
    ).toEqual([
      {
        type: "file",
        mediaType: "image/png",
        filename: "a.png",
        url: "https://cdn.example/a.png",
      },
    ]);
  });
});

describe("validateUserMessageAttachments", () => {
  it("passes text-only messages through", () => {
    const message = user([{ type: "text", text: "hello" }]);
    expect(validateUserMessageAttachments(message)).toEqual({
      ok: true,
      message,
    });
  });

  it("normalizes filename and media type", () => {
    const message = user([
      {
        type: "file",
        mediaType: "image/jpg",
        filename: "../secret/../shot.JPG",
        url: dataUrl("image/jpeg", "jpeg-bytes"),
      },
    ]);
    const result = validateUserMessageAttachments(message);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(collectFileParts(result.message)[0]).toMatchObject({
      mediaType: "image/jpeg",
      filename: "shot.JPG",
    });
  });

  it("rejects blob URLs, unsupported types, and too many files", () => {
    expect(
      validateUserMessageAttachments(
        user([
          {
            type: "file",
            mediaType: "image/png",
            filename: "a.png",
            url: "blob:https://app.local/1",
          },
        ]),
      ).ok,
    ).toBe(false);

    expect(
      validateUserMessageAttachments(
        user([
          {
            type: "file",
            mediaType: "application/zip",
            filename: "a.zip",
            url: dataUrl("application/zip", "zip"),
          },
        ]),
      ).ok,
    ).toBe(false);

    const many = Array.from({ length: CHAT_ATTACHMENT_MAX_FILES + 1 }, (_, i) => ({
      type: "file" as const,
      mediaType: "image/png",
      filename: `${i}.png`,
      url: "https://cdn.example/x.png",
    }));
    expect(validateUserMessageAttachments(user(many)).ok).toBe(false);
  });

  it("estimates base64 payload size", () => {
    const url = dataUrl("text/plain", "hello");
    expect(estimateDataUrlBytes(url)).toBe(5);
  });
});

describe("expandAttachmentPartsForModel", () => {
  it("inlines text documents and keeps images as file parts", () => {
    const message = user([
      { type: "text", text: "Match this copy" },
      {
        type: "file",
        mediaType: "text/markdown",
        filename: "copy.md",
        url: dataUrl("text/markdown", "# Hello"),
      },
      {
        type: "file",
        mediaType: "image/png",
        filename: "hero.png",
        url: dataUrl("image/png", "png"),
      },
    ]);

    const [expanded] = expandAttachmentPartsForModel([message]);
    expect(expanded?.parts.some((part) => part.type === "file")).toBe(true);
    const text = expanded?.parts.find((part) => part.type === "text");
    expect(text?.type === "text" && text.text).toContain("Match this copy");
    expect(text?.type === "text" && text.text).toContain("copy.md");
    expect(text?.type === "text" && text.text).toContain("# Hello");
    expect(
      expanded?.parts.filter((part) => part.type === "file"),
    ).toHaveLength(1);
  });

  it("turns a file-only text attachment into a text part", () => {
    const message = user([
      {
        type: "file",
        mediaType: "text/plain",
        filename: "notes.txt",
        url: dataUrl("text/plain", "use a navy header"),
      },
    ]);
    const [expanded] = expandAttachmentPartsForModel([message]);
    expect(expanded?.parts).toHaveLength(1);
    expect(expanded?.parts[0]).toMatchObject({ type: "text" });
    expect(
      expanded?.parts[0]?.type === "text" && expanded.parts[0].text,
    ).toContain("use a navy header");
  });
});
