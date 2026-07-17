/** App-server health: stdout buffers, next logs, compile probe. */
import fs from "node:fs/promises";
import path from "node:path";

import { getWorkspaceRoot } from "../paths";
import { isUnreliableCompileError } from "../preview-errors";

const LOG_BUFFER_LIMIT = 12_000;

const SUCCESS_MARKERS = [/compiled successfully/i, /✓\s*compiled/i, /✓\s*ready/i];
const ERROR_MARKERS = [
  /failed to compile/i,
  /parsing css source code failed/i,
  /module not found/i,
  /unhandled runtime error/i,
  /⨯ \.\//,
  /⨯/,
];

const DEV_LOG_COMPILE_MARKERS = [
  /Parsing CSS source code failed/i,
  /Failed to compile/i,
  /Module not found/i,
  /⨯ \.\//,
  /Turbopack build failed/i,
  /Event handlers cannot be passed/i,
  /Client Component props/i,
  /You're importing a component that needs/i,
  /Server Actions must be async/i,
  /⨯ Error:/,
];

const logBuffers = new Map<string, string>();
const buildErrors = new Map<string, string>();

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

export function recordDevOutput(sessionId: string, chunk: string): void {
  const clean = stripAnsi(chunk);
  const buffer = (logBuffers.get(sessionId) ?? "") + clean;
  logBuffers.set(sessionId, buffer.slice(-LOG_BUFFER_LIMIT));

  if (SUCCESS_MARKERS.some((marker) => marker.test(clean))) {
    buildErrors.delete(sessionId);
  }

  if (ERROR_MARKERS.some((marker) => marker.test(clean))) {
    const recent = (logBuffers.get(sessionId) ?? "").slice(-3_000).trim();
    if (!isUnreliableCompileError(recent)) {
      buildErrors.set(sessionId, recent);
    }
  }
}

export function resetSessionLogs(sessionId: string): void {
  logBuffers.set(sessionId, "");
  buildErrors.delete(sessionId);
}

export function getLocalBuildError(sessionId: string): string | null {
  return buildErrors.get(sessionId) ?? null;
}

export function setLocalBuildError(
  sessionId: string,
  error: string | null,
): void {
  if (error) {
    buildErrors.set(sessionId, error);
  } else {
    buildErrors.delete(sessionId);
  }
}

export function getDevServerLog(sessionId: string): string {
  return logBuffers.get(sessionId) ?? "";
}

function devLogPath(sessionId: string): string {
  return path.join(
    getWorkspaceRoot(sessionId),
    ".next/dev/logs/next-development.log",
  );
}

/**
 * Current length of the dev log so a probe can later scan only the lines that
 * were appended after it. The dev log is append-only, so scanning the whole
 * file surfaces errors from earlier (already-fixed) compiles.
 */
async function readDevLogLength(sessionId: string): Promise<number> {
  try {
    const content = await fs.readFile(devLogPath(sessionId), "utf8");
    return content.length;
  } catch {
    return 0;
  }
}

/**
 * Find the most recent compile error in the dev log.
 * Only `Server`-sourced entries are trusted: `Browser`-sourced entries are
 * console/overlay replays that keep re-reporting a stale error until the
 * browser tab reloads.
 */
export async function readLatestDevLogServerError(
  sessionId: string,
): Promise<string | null> {
  let content: string;
  try {
    content = await fs.readFile(devLogPath(sessionId), "utf8");
  } catch {
    return null;
  }

  let latestError: string | null = null;

  for (const line of content.split("\n")) {
    let entry: { source?: string; level?: string; message?: string };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.source !== "Server" || entry.level !== "ERROR" || !entry.message) {
      continue;
    }

    const message = entry.message
      .replace(/^"\[browser\] /, "")
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .trim();

    if (!DEV_LOG_COMPILE_MARKERS.some((marker) => marker.test(message))) {
      continue;
    }

    if (isUnreliableCompileError(message)) {
      continue;
    }

    latestError = message.slice(0, 2_000);
  }

  return latestError;
}

async function readDevLogCompileError(
  sessionId: string,
  sinceLength = 0,
): Promise<string | null> {
  let content: string;
  try {
    content = await fs.readFile(devLogPath(sessionId), "utf8");
  } catch {
    return null;
  }

  // If the log was rotated/truncated, fall back to scanning everything new.
  const offset = sinceLength > content.length ? 0 : sinceLength;
  const fresh = content.slice(offset).trim();
  if (!fresh) {
    return null;
  }

  let latestError: string | null = null;

  for (const line of fresh.split("\n")) {
    let entry: { source?: string; level?: string; message?: string };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.source !== "Server" || entry.level !== "ERROR" || !entry.message) {
      continue;
    }

    const message = entry.message
      .replace(/^"\[browser\] /, "")
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .trim();

    if (!DEV_LOG_COMPILE_MARKERS.some((marker) => marker.test(message))) {
      continue;
    }

    if (isUnreliableCompileError(message)) {
      continue;
    }

    latestError = message.slice(0, 2_000);
  }

  return latestError;
}

export interface PreviewProbeResult {
  httpStatus: number | null;
  buildError: string | null;
}

export async function probePreviewCompile(
  sessionId: string,
  url: string,
): Promise<PreviewProbeResult> {
  // Snapshot the log first so we only consider errors from the compile that
  // this probe triggers — not stale errors from earlier, already-fixed edits.
  const sinceLength = await readDevLogLength(sessionId);
  let httpStatus: number | null = null;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    httpStatus = response.status;
  } catch {
    // A compile error often returns 500 — still triggers Turbopack to log it.
  }

  await new Promise((resolve) => setTimeout(resolve, 2_000));

  let buildError = await readDevLogCompileError(sessionId, sinceLength);

  // When the page returns 5xx but no fresh log line was appended (common for
  // RSC/runtime errors logged on an earlier compile), fall back to the latest
  // server error instead of reporting a false negative.
  if (!buildError && httpStatus !== null && httpStatus >= 500) {
    buildError = await readLatestDevLogServerError(sessionId);
  }

  const looksTransient =
    httpStatus !== null &&
    httpStatus >= 500 &&
    (buildError === null || isUnreliableCompileError(buildError));

  if (looksTransient) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const retryStatus = await fetch(url, { signal: AbortSignal.timeout(5_000) })
      .then((response) => response.status)
      .catch(() => httpStatus);
    httpStatus = retryStatus;
    const retryError = await readDevLogCompileError(sessionId, sinceLength);
    if (retryError && !isUnreliableCompileError(retryError)) {
      buildError = retryError;
    } else if (retryStatus !== null && retryStatus < 500) {
      buildError = null;
    }
  }

  return { httpStatus, buildError };
}

export async function isPortAlive(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.status < 600;
  } catch {
    return false;
  }
}
