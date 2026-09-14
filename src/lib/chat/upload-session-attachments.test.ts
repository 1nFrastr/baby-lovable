import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileUIPart } from "ai";

import {
  ATTACHMENT_UPLOAD_AUTH_RETRIES,
  shouldRetryAttachmentUpload,
  uploadSessionAttachments,
} from "./upload-session-attachments";

const stored: FileUIPart[] = [
  {
    type: "file",
    mediaType: "image/png",
    filename: "shot.png",
    url: "attachment://att_1",
  },
];

const incoming: FileUIPart[] = [
  {
    type: "file",
    mediaType: "image/png",
    filename: "shot.png",
    url: "blob:http://localhost/shot",
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function blobResponse(): Response {
  return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
}

describe("shouldRetryAttachmentUpload", () => {
  it("retries only Unauthorized", () => {
    expect(shouldRetryAttachmentUpload(401)).toBe(true);
    expect(shouldRetryAttachmentUpload(400)).toBe(false);
    expect(shouldRetryAttachmentUpload(403)).toBe(false);
    expect(shouldRetryAttachmentUpload(500)).toBe(false);
  });
});

describe("uploadSessionAttachments", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns stored files when the first POST succeeds", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/attachments")) {
        return jsonResponse({ files: stored });
      }
      return blobResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      uploadSessionAttachments("sess_1", incoming),
    ).resolves.toEqual(stored);

    const posts = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("/attachments"),
    );
    expect(posts).toHaveLength(1);
  });

  it("retries a 401 then succeeds", async () => {
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (!String(input).includes("/attachments")) {
          return blobResponse();
        }
        posts += 1;
        if (posts === 1) {
          return jsonResponse({ error: "Unauthorized" }, 401);
        }
        return jsonResponse({ files: stored });
      }),
    );

    await expect(
      uploadSessionAttachments("sess_1", incoming),
    ).resolves.toEqual(stored);
    expect(posts).toBe(2);
  });

  it("does not retry a validation error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (!String(input).includes("/attachments")) {
          return blobResponse();
        }
        return jsonResponse({ error: "Unsupported file type" }, 400);
      }),
    );

    await expect(
      uploadSessionAttachments("sess_1", incoming),
    ).rejects.toThrow("Unsupported file type");
  });

  it("gives up after auth retries and asks to refresh", async () => {
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (!String(input).includes("/attachments")) {
          return blobResponse();
        }
        posts += 1;
        return jsonResponse({ error: "Unauthorized" }, 401);
      }),
    );

    await expect(
      uploadSessionAttachments("sess_1", incoming),
    ).rejects.toThrow(/Refresh the page/);
    expect(posts).toBe(1 + ATTACHMENT_UPLOAD_AUTH_RETRIES);
  });
});
