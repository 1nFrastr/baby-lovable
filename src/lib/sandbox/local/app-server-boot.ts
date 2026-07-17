/** App-server boot: pnpm install + start/stop local `pnpm dev`. */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { getWorkspaceRoot } from "../paths";
import { resolvePackageManager } from "../package-manager";
import type { AppServerStatus } from "../preview-types";
import {
  getDevServerLog,
  isPortAlive,
  recordDevOutput,
  resetSessionLogs,
} from "./app-server-health";

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
const startingPromises = new Map<string, Promise<AppServerStatus>>();
const installingPromises = new Map<string, Promise<boolean>>();
const bootstrapPromises = new Map<string, Promise<void>>();

const BASE_PORT = 3200;
const PORT_RANGE = 800;

export function sessionPort(sessionId: string): number {
  let hash = 0;
  for (const char of sessionId) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return BASE_PORT + (hash % PORT_RANGE);
}

export async function hasLocalNodeModules(sessionId: string): Promise<boolean> {
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
  if (await hasLocalNodeModules(sessionId)) {
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

export async function resolveActivePreviewUrl(
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

export function getLocalAppServerMemoryStatus(sessionId: string): AppServerStatus {
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

export async function stopDevSession(sessionId: string): Promise<void> {
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

async function startDevServer(sessionId: string): Promise<AppServerStatus> {
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
  resetSessionLogs(sessionId);

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
    await stopDevSession(sessionId);
    return { status: "error", error: state.error };
  }

  state.status = "ready";
  state.url = `http://localhost:${port}`;
  return { status: "ready", url: state.url, port };
}

/** Install if needed + start. Reuses healthy preview when present. */
export async function runStart(sessionId: string): Promise<AppServerStatus> {
  const existing = servers.get(sessionId);
  if (existing?.status === "ready" && existing.url) {
    if (await isPortAlive(existing.port)) {
      return { status: "ready", url: existing.url, port: existing.port };
    }
    await stopDevSession(sessionId);
  }

  if (existing?.status === "starting") {
    const pending = startingPromises.get(sessionId);
    if (pending) {
      return pending;
    }
  }

  const hasDeps = await hasLocalNodeModules(sessionId);
  if (!hasDeps) {
    return { status: "needs_install" };
  }

  // Clear any managed process and orphaned listeners before (re)starting.
  await stopDevSession(sessionId);
  await killPortListeners(sessionPort(sessionId));

  const promise = startDevServer(sessionId);
  startingPromises.set(sessionId, promise);

  try {
    return await promise;
  } finally {
    startingPromises.delete(sessionId);
  }
}

async function bootstrapPreview(sessionId: string): Promise<void> {
  const installed = await ensureDependencies(sessionId);
  if (!installed) {
    return;
  }

  await runStart(sessionId);
}

/** Fire-and-forget install + boot (idempotent). */
export function kickOffBootstrap(sessionId: string): void {
  if (bootstrapPromises.has(sessionId)) {
    return;
  }

  const promise = bootstrapPreview(sessionId).finally(() => {
    bootstrapPromises.delete(sessionId);
  });
  bootstrapPromises.set(sessionId, promise);
}

/**
 * If bootstrap is already running, wait for it. Never starts a new one.
 */
export async function waitForInFlightStart(
  sessionId: string,
  getStatus: (sessionId: string) => Promise<AppServerStatus>,
  timeoutMs = 90_000,
): Promise<AppServerStatus> {
  const pending = bootstrapPromises.get(sessionId);
  if (pending) {
    await Promise.race([
      pending.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  const deadline = Date.now() + Math.min(timeoutMs, 5_000);
  while (Date.now() < deadline) {
    const status = await getStatus(sessionId);
    if (
      status.status === "ready" ||
      status.status === "error" ||
      status.status === "stopped" ||
      status.status === "needs_install"
    ) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return getStatus(sessionId);
}

export async function clearNextCache(sessionId: string): Promise<void> {
  try {
    await fs.rm(path.join(getWorkspaceRoot(sessionId), ".next"), {
      recursive: true,
      force: true,
    });
  } catch {
    // Best effort — a missing .next is fine.
  }
}
