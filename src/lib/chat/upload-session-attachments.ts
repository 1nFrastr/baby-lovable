import type { FileUIPart } from "ai";

/** Extra POSTs after the first when the session cookie is mid-refresh. */
export const ATTACHMENT_UPLOAD_AUTH_RETRIES = 2;

const ATTACHMENT_UPLOAD_RETRY_DELAY_MS = 200;

/**
 * Wait for the browser Supabase client to finish an in-flight token refresh
 * so the following fetch sends a complete cookie set.
 */
async function settleBrowserAuthSession(): Promise<void> {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const { createSupabaseBrowserClient } = await import(
      "@/lib/supabase/client"
    );
    await createSupabaseBrowserClient().auth.getUser();
  } catch {
    // Upload retries still cover a cookie / refresh race.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function shouldRetryAttachmentUpload(status: number): boolean {
  return status === 401;
}

async function readComposerFiles(files: FileUIPart[]): Promise<File[]> {
  const prepared: File[] = [];
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
    prepared.push(
      new File([blob], file.filename ?? "file", {
        type: file.mediaType || blob.type,
      }),
    );
  }
  return prepared;
}

function formFromFiles(files: File[]): FormData {
  const form = new FormData();
  for (const file of files) {
    form.append("file", file);
  }
  return form;
}

/**
 * Upload composer files (blob or data URLs) to Storage. The chat POST then
 * carries `attachment://` URLs only.
 *
 * A 401 here is usually a stale or half-rotated Supabase cookie (the browser
 * client and API `getUser()` both refresh). Retrying after the cookie settles
 * succeeds; surface a session error only if every attempt still 401s.
 */
export async function uploadSessionAttachments(
  sessionId: string,
  files: FileUIPart[],
): Promise<FileUIPart[]> {
  if (files.length === 0) {
    return [];
  }

  await settleBrowserAuthSession();
  const prepared = await readComposerFiles(files);

  let lastError = new Error("Upload failed");
  for (let attempt = 0; attempt <= ATTACHMENT_UPLOAD_AUTH_RETRIES; attempt++) {
    if (attempt > 0) {
      await settleBrowserAuthSession();
      await delay(ATTACHMENT_UPLOAD_RETRY_DELAY_MS * attempt);
    }

    const response = await fetch(`/api/sessions/${sessionId}/attachments`, {
      method: "POST",
      body: formFromFiles(prepared),
      credentials: "same-origin",
    });
    const data = (await response.json().catch(() => null)) as
      | { error?: string; files?: FileUIPart[] }
      | null;

    if (response.ok) {
      if (!data?.files || data.files.length !== files.length) {
        throw new Error("Upload did not return every attached file.");
      }
      return data.files;
    }

    if (shouldRetryAttachmentUpload(response.status)) {
      lastError = new Error(
        "Could not upload files. Refresh the page and try again.",
      );
      continue;
    }

    throw new Error(data?.error ?? `Upload failed (${response.status})`);
  }

  throw lastError;
}
