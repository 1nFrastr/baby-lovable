import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { getWorkspaceRoot } from "./paths";

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
  external?: boolean;
  status: "starting" | "ready" | "error";
  url?: string;
  error?: string;
}

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
];

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
    buildErrors.set(sessionId, recent);
  }
}

export function getBuildError(sessionId: string): string | null {
  return buildErrors.get(sessionId) ?? null;
}

export function getDevServerLog(sessionId: string): string {
  return logBuffers.get(sessionId) ?? "";
}

async function readLatestDevLogError(sessionId: string): Promise<string | null> {
  const logPath = path.join(
    getWorkspaceRoot(sessionId),
    ".next/dev/logs/next-development.log",
  );

  try {
    const content = await fs.readFile(logPath, "utf8");
    const lines = content.trim().split("\n").reverse();

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as {
          level?: string;
          message?: string;
        };

        if (entry.level !== "ERROR" || !entry.message) {
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

        return message.slice(0, 2_000);
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function probePreviewCompile(
  sessionId: string,
  url: string,
): Promise<string | null> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(5_000) });
  } catch {
    // A compile error often returns 500 — still triggers Turbopack to log it.
  }

  await new Promise((resolve) => setTimeout(resolve, 1_500));
  return (await readLatestDevLogError(sessionId)) ?? getBuildError(sessionId);
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

function runPnpmInstall(workspaceRoot: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["install"], {
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
  const promise = runPnpmInstall(workspaceRoot);
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

function registerExternalDevServer(sessionId: string, port: number): void {
  servers.set(sessionId, {
    sessionId,
    port,
    external: true,
    status: "ready",
    url: `http://localhost:${port}`,
  });
}

async function resolveActivePreviewUrl(
  sessionId: string,
): Promise<{ url: string; port: number } | null> {
  const status = getPreviewStatus(sessionId);
  if (status.status === "ready") {
    return { url: status.url, port: status.port };
  }

  const port = sessionPort(sessionId);
  if (await isPortAlive(port)) {
    registerExternalDevServer(sessionId, port);
    return { url: `http://localhost:${port}`, port };
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
      if (response.ok || response.status < 500) {
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
  if (!state) {
    return;
  }

  if (!state.external && state.process) {
    state.process.kill("SIGTERM");
  }

  servers.delete(sessionId);
  startingPromises.delete(sessionId);
}

export async function ensureDevServer(sessionId: string): Promise<PreviewStatus> {
  const existing = servers.get(sessionId);
  if (existing?.status === "ready" && existing.url) {
    return { status: "ready", url: existing.url, port: existing.port };
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

  const port = sessionPort(sessionId);
  if (await isPortAlive(port)) {
    registerExternalDevServer(sessionId, port);
    return { status: "ready", url: `http://localhost:${port}`, port };
  }

  if (existing) {
    await stopDevServer(sessionId);
  }

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

  const child = spawn("pnpm", ["dev", "--port", String(port)], {
    cwd: workspaceRoot,
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
  return ensureDevServer(sessionId);
}

export interface PreviewReport {
  status: PreviewStatus["status"];
  url?: string;
  buildError: string | null;
}

/**
 * Snapshot of the current preview used to feed dev-server compile errors back
 * to the agent. Waits briefly so a compile triggered by the agent's last edit
 * has a chance to surface before we report.
 */
export async function getPreviewReport(sessionId: string): Promise<PreviewReport> {
  // Actively resolve/bootstrap the preview instead of passively reporting
  // "stopped". In CLI/headless contexts the frontend never opens the preview
  // panel, so this is what installs deps + boots the dev server on demand.
  const resolved = await resolvePreviewStatus(sessionId);

  let buildError =
    (await readLatestDevLogError(sessionId)) ?? getBuildError(sessionId);

  if (resolved.status === "ready") {
    buildError = await probePreviewCompile(sessionId, resolved.url);
    if (buildError) {
      buildErrors.set(sessionId, buildError);
    } else {
      buildErrors.delete(sessionId);
    }
  }

  return {
    status: resolved.status,
    url: resolved.status === "ready" ? resolved.url : undefined,
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
