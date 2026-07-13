import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { getWorkspaceRoot } from "./paths";
import { resolvePackageManager } from "./package-manager";

export type PreviewStatus =
  | { status: "installing" }
  | { status: "needs_install" }
  | { status: "starting"; port: number }
  | { status: "ready"; url: string; port: number }
  | { status: "error"; error: string }
  | { status: "stopped" };

interface DevServerState {
  sessionId: string;
  port: number;
  process?: ChildProcess;
  status: "starting" | "ready" | "error";
  url?: string;
  error?: string;
}

const execFileAsync = promisify(execFile);

const servers = new Map<string, DevServerState>();
const startingPromises = new Map<string, Promise<PreviewStatus>>();
const installingPromises = new Map<string, Promise<boolean>>();
const bootstrapPromises = new Map<string, Promise<void>>();
const logBuffers = new Map<string, string>();
const buildErrors = new Map<string, string>();

const BASE_PORT = 3200;
const PORT_RANGE = 800;
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

/** Browser overlay replays tagged in the dev log — not trustworthy compile errors. */
export function isUnreliableCompileError(message: string): boolean {
  return /\[browser\]/i.test(message);
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function recordDevOutput(sessionId: string, chunk: string): void {
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

export function getBuildError(sessionId: string): string | null {
  return buildErrors.get(sessionId) ?? null;
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
 * Find the most recent compile error in the dev log, considering only lines
 * appended after `sinceLength`. Only `Server`-sourced entries are trusted:
 * `Browser`-sourced entries are console/overlay replays that keep re-reporting
 * a stale error until the browser tab reloads, which otherwise makes a
 * fixed file look permanently broken.
 */
async function readLatestDevLogServerError(
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

interface PreviewProbeResult {
  httpStatus: number | null;
  buildError: string | null;
}

async function probePreviewCompile(
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

export function sessionPort(sessionId: string): number {
  let hash = 0;
  for (const char of sessionId) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return BASE_PORT + (hash % PORT_RANGE);
}

export async function hasNodeModules(sessionId: string): Promise<boolean> {
  try {
    const workspaceRoot = getWorkspaceRoot(sessionId);
    const stat = await fs.stat(path.join(workspaceRoot, "node_modules"));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function hasPackageJson(sessionId: string): Promise<boolean> {
  try {
    const workspaceRoot = getWorkspaceRoot(sessionId);
    await fs.access(path.join(workspaceRoot, "package.json"));
    return true;
  } catch {
    return false;
  }
}

function runPackageInstall(workspaceRoot: string): Promise<boolean> {
  const pm = resolvePackageManager("local");
  const [binary, ...args] = pm.install.split(" ");
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      cwd: workspaceRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

export async function ensureDependencies(sessionId: string): Promise<boolean> {
  if (await hasNodeModules(sessionId)) {
    return true;
  }

  const pending = installingPromises.get(sessionId);
  if (pending) {
    return pending;
  }

  if (!(await hasPackageJson(sessionId))) {
    return false;
  }

  const workspaceRoot = getWorkspaceRoot(sessionId);
  const promise = runPackageInstall(workspaceRoot);
  installingPromises.set(sessionId, promise);

  try {
    return await promise;
  } finally {
    installingPromises.delete(sessionId);
  }
}

async function isPortAlive(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.status < 600;
  } catch {
    return false;
  }
}

async function getListenerPids(port: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("lsof", [
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-t",
    ]);
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((pid) => Number(pid))
      .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
}

async function killProcessTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-P", String(pid)]);
    const children = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((child) => Number(child))
      .filter((child) => Number.isFinite(child) && child > 0);

    await Promise.all(children.map((child) => killProcessTree(child, signal)));
  } catch {
    // No child processes.
  }

  try {
    process.kill(pid, signal);
  } catch {
    // Already exited.
  }
}

/**
 * Kill every process listening on `port`. `pnpm dev` spawns `next dev` and
 * `next-server` grandchildren; killing only the parent leaves orphans that
 * block the next start with "Failed to start server".
 */
async function killPortListeners(port: number): Promise<void> {
  for (const pid of await getListenerPids(port)) {
    await killProcessTree(pid, "SIGTERM");
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    if ((await getListenerPids(port)).length === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  for (const pid of await getListenerPids(port)) {
    await killProcessTree(pid, "SIGKILL");
  }
}

async function resolveActivePreviewUrl(
  sessionId: string,
): Promise<{ url: string; port: number } | null> {
  const state = servers.get(sessionId);
  if (state?.status === "ready" && state.url) {
    if (await isPortAlive(state.port)) {
      return { url: state.url, port: state.port };
    }
  }

  // Adopt an already-listening dev server even when in-memory state was lost or
  // is still marked "starting" (e.g. after a workflow step restart).
  const port = sessionPort(sessionId);
  if (await isPortAlive(port)) {
    const url = `http://localhost:${port}`;
    if (state) {
      state.status = "ready";
      state.url = url;
      state.port = port;
    } else {
      servers.set(sessionId, {
        sessionId,
        port,
        status: "ready",
        url,
      });
    }
    return { url, port };
  }

  return null;
}

async function waitForReady(port: number, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status < 600) {
        return true;
      }
    } catch {
      // Server not ready yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

export function getPreviewStatus(sessionId: string): PreviewStatus {
  if (installingPromises.has(sessionId)) {
    return { status: "installing" };
  }

  const state = servers.get(sessionId);
  if (!state) {
    return { status: "stopped" };
  }

  if (state.status === "ready" && state.url) {
    return { status: "ready", url: state.url, port: state.port };
  }

  if (state.status === "starting") {
    return { status: "starting", port: state.port };
  }

  return {
    status: "error",
    error: state.error ?? "Dev server failed",
  };
}

export async function stopDevServer(sessionId: string): Promise<void> {
  const state = servers.get(sessionId);
  const port = state?.port ?? sessionPort(sessionId);

  if (state?.process?.pid) {
    try {
      // detached spawn makes the child a process-group leader; -pid kills the
      // whole tree (pnpm → next dev → next-server).
      process.kill(-state.process.pid, "SIGTERM");
    } catch {
      try {
        state.process.kill("SIGTERM");
      } catch {
        // Already exited.
      }
    }
  }

  await killPortListeners(port);

  servers.delete(sessionId);
  startingPromises.delete(sessionId);
}

export async function ensureDevServer(sessionId: string): Promise<PreviewStatus> {
  const existing = servers.get(sessionId);
  if (existing?.status === "ready" && existing.url) {
    if (await isPortAlive(existing.port)) {
      return { status: "ready", url: existing.url, port: existing.port };
    }
    await stopDevServer(sessionId);
  }

  if (existing?.status === "starting") {
    const pending = startingPromises.get(sessionId);
    if (pending) {
      return pending;
    }
  }

  const hasDeps = await hasNodeModules(sessionId);
  if (!hasDeps) {
    return { status: "needs_install" };
  }

  // Clear any managed process and orphaned listeners before (re)starting.
  await stopDevServer(sessionId);
  await killPortListeners(sessionPort(sessionId));

  const promise = startDevServer(sessionId);
  startingPromises.set(sessionId, promise);

  try {
    return await promise;
  } finally {
    startingPromises.delete(sessionId);
  }
}

async function startDevServer(sessionId: string): Promise<PreviewStatus> {
  const workspaceRoot = getWorkspaceRoot(sessionId);
  const port = sessionPort(sessionId);
  const pm = resolvePackageManager("local");
  const devParts = pm.dev(port).split(" ");
  const [binary, ...args] = devParts;

  const child = spawn(binary, args, {
    cwd: workspaceRoot,
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const state: DevServerState = {
    sessionId,
    port,
    process: child,
    status: "starting",
  };
  servers.set(sessionId, state);
  logBuffers.set(sessionId, "");
  buildErrors.delete(sessionId);

  const onOutput = (chunk: Buffer) => {
    recordDevOutput(sessionId, chunk.toString());
  };
  child.stdout?.on("data", onOutput);
  child.stderr?.on("data", onOutput);

  child.on("exit", (code) => {
    if (servers.get(sessionId) !== state) {
      return;
    }

    state.status = "error";
    state.error =
      code === 0
        ? "Dev server stopped"
        : getDevServerLog(sessionId).slice(-500) ||
          `Exited with code ${code ?? "unknown"}`;
  });

  const ready = await waitForReady(port);
  if (!ready) {
    state.status = "error";
    state.error =
      getDevServerLog(sessionId).slice(-500) ||
      "Dev server failed to start in time";
    await stopDevServer(sessionId);
    return { status: "error", error: state.error };
  }

  state.status = "ready";
  state.url = `http://localhost:${port}`;
  return { status: "ready", url: state.url, port };
}

async function bootstrapPreview(sessionId: string): Promise<void> {
  const installed = await ensureDependencies(sessionId);
  if (!installed) {
    return;
  }

  await ensureDevServer(sessionId);
}

function kickOffBootstrap(sessionId: string): void {
  if (bootstrapPromises.has(sessionId)) {
    return;
  }

  const promise = bootstrapPreview(sessionId).finally(() => {
    bootstrapPromises.delete(sessionId);
  });
  bootstrapPromises.set(sessionId, promise);
}

/**
 * Start installing dependencies and booting the dev server in the background
 * (idempotent). Call this at the beginning of an agent turn so the preview is
 * warming up in parallel with codegen — the agent should not have to run
 * `pnpm install` / `pnpm dev` itself.
 */
export function ensurePreviewBootstrap(sessionId: string): void {
  kickOffBootstrap(sessionId);
}

export async function restartDevServer(sessionId: string): Promise<PreviewStatus> {
  await stopDevServer(sessionId);

  // Safe to clear build output only after the managed dev server is stopped.
  try {
    await fs.rm(path.join(getWorkspaceRoot(sessionId), ".next"), {
      recursive: true,
      force: true,
    });
  } catch {
    // Best effort — a missing .next is fine.
  }

  return ensureDevServer(sessionId);
}

export interface PreviewReport {
  status: PreviewStatus["status"];
  url?: string;
  httpStatus?: number;
  buildError: string | null;
}

export function isTransientPreviewFailure(report: PreviewReport): boolean {
  if (report.status !== "ready") {
    return false;
  }

  if (
    report.httpStatus !== undefined &&
    report.httpStatus < 500 &&
    report.buildError === null
  ) {
    return false;
  }

  if (report.buildError && !isUnreliableCompileError(report.buildError)) {
    return false;
  }

  return (
    (report.httpStatus !== undefined && report.httpStatus >= 500) ||
    report.buildError !== null
  );
}

/**
 * Snapshot of the current preview used to feed dev-server compile errors back
 * to the agent. Waits briefly so a compile triggered by the agent's last edit
 * has a chance to surface before we report.
 */
async function waitForPreviewReady(
  sessionId: string,
  timeoutMs = 90_000,
): Promise<PreviewStatus> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = await resolvePreviewStatus(sessionId);
    if (status.status === "ready" || status.status === "error") {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return getPreviewStatus(sessionId);
}

export async function getPreviewReport(
  sessionId: string,
  options?: { restart?: boolean },
): Promise<PreviewReport> {
  if (options?.restart) {
    await restartDevServer(sessionId);
    await waitForPreviewReady(sessionId);
  }

  // Actively resolve/bootstrap the preview instead of passively reporting
  // "stopped". In CLI/headless contexts the frontend never opens the preview
  // panel, so this is what installs deps + boots the dev server on demand.
  const resolved = await resolvePreviewStatus(sessionId);

  // Default to the in-memory error, which is kept fresh for managed dev servers
  // (cleared on a successful recompile). Avoid scraping the append-only dev log
  // wholesale, since that resurfaces stale errors from already-fixed edits.
  let buildError = getBuildError(sessionId);

  let httpStatus: number | undefined;

  if (resolved.status === "ready") {
    const probe = await probePreviewCompile(sessionId, resolved.url);
    httpStatus = probe.httpStatus ?? undefined;
    buildError = probe.buildError;
    if (
      !buildError &&
      httpStatus !== undefined &&
      httpStatus >= 500
    ) {
      buildError =
        (await readLatestDevLogServerError(sessionId)) ??
        `Preview returned HTTP ${httpStatus} but no compile error was captured. Inspect source files or call checkPreview with restart: true.`;
    }
    if (buildError) {
      buildErrors.set(sessionId, buildError);
    } else {
      buildErrors.delete(sessionId);
    }
  }

  return {
    status: resolved.status,
    url: resolved.status === "ready" ? resolved.url : undefined,
    httpStatus,
    buildError,
  };
}

export async function resolvePreviewStatus(
  sessionId: string,
): Promise<PreviewStatus> {
  const active = await resolveActivePreviewUrl(sessionId);
  if (active) {
    return { status: "ready", url: active.url, port: active.port };
  }

  const current = getPreviewStatus(sessionId);
  if (
    current.status === "ready" ||
    current.status === "starting" ||
    current.status === "installing"
  ) {
    return current;
  }

  if (await hasNodeModules(sessionId)) {
    kickOffBootstrap(sessionId);
    return getPreviewStatus(sessionId).status === "stopped"
      ? { status: "starting", port: sessionPort(sessionId) }
      : getPreviewStatus(sessionId);
  }

  if (await hasPackageJson(sessionId)) {
    kickOffBootstrap(sessionId);
    return { status: "installing" };
  }

  return { status: "needs_install" };
}
