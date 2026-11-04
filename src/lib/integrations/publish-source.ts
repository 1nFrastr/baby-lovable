import { createHash } from "node:crypto";

import { Freestyle } from "freestyle";

import { awaitPreviousCheckpoint } from "@/lib/git/await-checkpoint";
import { getFreestyleAdapter } from "@/lib/git/freestyle-client";
import { getFreestyleApiKey } from "@/lib/git/freestyle-config";
import { readGitRepository } from "@/lib/git/repository-store";
import { getSessionMeta } from "@/lib/session/store";

const MAX_ENTRIES = 10_000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
// Base64 and JSON overhead also count against a bounded network budget.
const MAX_RESPONSE_BYTES = 150 * 1024 * 1024;
const MAX_DEPTH = 64;
const SHA = /^[a-f0-9]{40}$/i;
const EXCLUDED = new Set([".git", "node_modules", ".next", ".baby"]);

type PublishFile = { path: string; content: Buffer; mode?: number };
type Entry = { path: string; sha: string; type: "file" | "dir"; size?: number; mode: number };

function assertServer(): void {
  if (typeof window !== "undefined") {
    throw new Error("Publish source is only available on the server.");
  }
}

function validateSource(repoId: string, sha: string): void {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(repoId) || !SHA.test(sha)) {
    throw new Error("Publish source requires a repository ID and a full commit SHA.");
  }
}

/** Pin remote main after completed turns have reached durable source control. */
export async function resolvePublishSource(
  sessionId: string,
  userId: string,
): Promise<{ repoId: string; sha: string }> {
  assertServer();
  if (!userId) throw new Error("Authentication is required to publish source.");
  const session = await getSessionMeta(sessionId, { userId });
  if (!session || session.userId !== userId) {
    throw new Error("Publish session was not found or access was denied.");
  }

  await awaitPreviousCheckpoint(sessionId, { userId });
  const repo = await readGitRepository(sessionId, userId);
  if (
    !repo?.repoId || repo.provider !== "freestyle" ||
    repo.provisionStatus !== "ready" || repo.unrecoverable ||
    repo.syncStatus === "error" || repo.syncStatus === "conflict"
  ) {
    throw new Error("Freestyle source is not ready to publish.");
  }

  let sha: string | null;
  try {
    // The stored remoteHeadSha is only a projection; query the actual main tip.
    sha = await getFreestyleAdapter().listLatestCommitSha(repo.repoId, "main");
  } catch {
    // Provider errors can carry authentication headers or URLs; do not propagate.
    throw new Error("Unable to resolve the Freestyle main commit.");
  }
  if (!sha || !SHA.test(sha)) throw new Error("Freestyle main has no valid commit to publish.");
  validateSource(repo.repoId, sha);
  return { repoId: repo.repoId, sha };
}

function invalidResponse(): never {
  throw new Error("Freestyle returned invalid pinned source contents.");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidResponse();
  return value as Record<string, unknown>;
}

function validatePath(value: unknown): string {
  if (
    typeof value !== "string" || !value || Buffer.byteLength(value) > 4096 ||
    /[\\:\p{Cc}]/u.test(value) || Buffer.from(value).toString("utf8") !== value ||
    value.split("/").some((part) => !part || part === "." || part === "..") ||
    value.split("/").length > MAX_DEPTH
  ) {
    throw new Error("Publish source contains an unsafe file path.");
  }
  return value;
}

function readEntry(value: unknown): Entry {
  const entry = object(value);
  const path = validatePath(entry.path);
  if (entry.type !== "file" && entry.type !== "dir") {
    throw new Error("Publish source cannot contain symlinks or special files.");
  }
  if (typeof entry.sha !== "string" || !SHA.test(entry.sha)) invalidResponse();
  let mode = 0o644;
  if (entry.mode !== undefined) {
    const parsed = typeof entry.mode === "string" && /^[0-7]{6}$/.test(entry.mode)
      ? parseInt(entry.mode, 8) : entry.mode;
    if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0o177777) invalidResponse();
    const kind = parsed & 0o170000;
    if (kind !== 0 && kind !== (entry.type === "dir" ? 0o040000 : 0o100000)) {
      throw new Error("Publish source cannot contain symlinks or special files.");
    }
    mode = parsed & 0o777;
  }
  if (entry.type === "file" && (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0)) invalidResponse();
  return { path, type: entry.type, sha: entry.sha, size: entry.size as number | undefined, mode };
}

/** Bound aggregate response bytes before the SDK buffers/decodes JSON. */
function sourceFetch(): typeof fetch {
  const signal = AbortSignal.timeout(90_000);
  let received = 0;
  return async (input, init) => {
    const response = await fetch(input, { ...init, redirect: "error", cache: "no-store", signal });
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES - received) {
      await response.body?.cancel();
      throw new Error("Source download failed or exceeded its limit.");
    }
    const reader = response.body.getReader();
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            reader.releaseLock();
            return;
          }
          received += value.byteLength;
          if (received > MAX_RESPONSE_BYTES) throw new Error("Source response limit exceeded.");
          controller.enqueue(value);
        } catch {
          await reader.cancel().catch(() => {});
          controller.error(new Error("Source download failed or exceeded its limit."));
        }
      },
      cancel: () => reader.cancel(),
    }));
  };
}

/**
 * Read the Files API at the exact commit, independent of archive export-ignore /
 * export-subst attributes. Never checkout, extract, execute, or follow a link.
 * The API omits Unix modes: every returned blob becomes a regular file buffer
 * (including any raw link-target blob), with its Git object hash verified.
 */
export async function exportPublishSource(repoId: string, sha: string): Promise<PublishFile[]> {
  assertServer();
  validateSource(repoId, sha);
  const client = new Freestyle({ apiKey: getFreestyleApiKey(), fetch: sourceFetch() });
  const repo = client.git.repos.ref({ repoId });
  const get = async (path: string): Promise<Record<string, unknown>> => {
    try {
      return object(await repo.contents.get({ path, rev: sha }));
    } catch {
      // Do not retain provider errors or causes that could contain credentials.
      throw new Error("Unable to read the pinned Freestyle source commit.");
    }
  };

  const pending: { path: string; sha?: string }[] = [{ path: "" }];
  const seen = new Set<string>();
  const files: Entry[] = [];
  let total = 0;
  for (let index = 0; index < pending.length; index++) {
    const directory = pending[index];
    const listing = await get(directory.path);
    if (listing.type !== "dir" || listing.path !== directory.path || !Array.isArray(listing.entries) ||
      (directory.sha && listing.sha !== directory.sha)) invalidResponse();
    if (listing.entries.length > MAX_ENTRIES - seen.size) throw new Error("Publish source has too many files.");
    for (const value of listing.entries) {
      const entry = readEntry(value);
      if (entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))) !== directory.path || seen.has(entry.path)) invalidResponse();
      seen.add(entry.path);
      const parts = entry.path.split("/");
      if (parts.some((part) => /^\.env/i.test(part) && part !== ".env.example" && part !== ".env.template")) {
        throw new Error("Publish source contains a tracked private environment file. Remove it from Git before publishing.");
      }
      if (entry.type === "dir") {
        // Inspect all tracked paths, even excluded trees, so private env files
        // cannot evade the refusal by living under an internal directory.
        pending.push(entry);
      } else if (!parts.some((part) => EXCLUDED.has(part.toLowerCase()))) {
        total += entry.size!;
        if (entry.size! > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) throw new Error("Publish source exceeds the file size limit.");
        files.push(entry);
      }
    }
  }

  // Complete metadata validation (including private env checks) before any blobs.
  const result: PublishFile[] = [];
  for (const entry of files) {
    const file = await get(entry.path);
    readEntry(file);
    if (file.type !== "file" || file.path !== entry.path || file.sha !== entry.sha || file.size !== entry.size ||
      typeof file.content !== "string" || file.content.length !== 4 * Math.ceil(entry.size! / 3)) invalidResponse();
    const content = Buffer.from(file.content, "base64");
    if (content.length !== entry.size || content.toString("base64") !== file.content) invalidResponse();
    const hash = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
    if (hash !== entry.sha.toLowerCase()) invalidResponse();
    result.push({ path: entry.path, content, mode: entry.mode });
  }
  return result;
}
