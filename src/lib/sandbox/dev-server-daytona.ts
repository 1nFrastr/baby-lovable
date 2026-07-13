import type { PreviewStatus } from "./dev-server";
import { isUnreliableCompileError } from "./dev-server";
import { logDaytonaBootstrap } from "./daytona/bootstrap-log";
import { getDaytonaDevPort, DAYTONA_WORKSPACE_ROOT } from "./daytona/config";
import {
  destroyDaytonaSandbox,
  getManagedDaytonaSdkSandbox,
  getOrCreateDaytonaSandbox,
} from "./daytona/sandbox-manager";
import { resolvePackageManager } from "./package-manager";
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

interface DaytonaPreviewState {
  status: PreviewStatus["status"];
  url?: string;
  token?: string;
  port: number;
  error?: string;
  devSessionId: string;
}

const daytonaStates = new Map<string, DaytonaPreviewState>();
const daytonaBootstrapPromises = new Map<string, Promise<void>>();
const daytonaBuildErrors = new Map<string, string>();
const daytonaDevLogs = new Map<string, string>();

export function getDaytonaBuildError(sessionId: string): string | null {
  return daytonaBuildErrors.get(sessionId) ?? null;
}

function getDevPort(): number {
  return getDaytonaDevPort();
}

function recordDaytonaOutput(sessionId: string, chunk: string): void {
  const buffer = (daytonaDevLogs.get(sessionId) ?? "") + chunk;
  daytonaDevLogs.set(sessionId, buffer.slice(-12_000));

  if (/compiled successfully/i.test(chunk) || /✓\s*ready/i.test(chunk)) {
    daytonaBuildErrors.delete(sessionId);
  }

  if (
    /failed to compile/i.test(chunk) ||
    /module not found/i.test(chunk) ||
    /⨯ \.\//.test(chunk)
  ) {
    const recent = (daytonaDevLogs.get(sessionId) ?? "").slice(-3_000).trim();
    if (!isUnreliableCompileError(recent)) {
      daytonaBuildErrors.set(sessionId, recent);
    }
  }
}

function extractCompileErrorFromLog(content: string): string | null {
  const lines = content.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index] ?? "";
    if (DEV_LOG_COMPILE_MARKERS.some((marker) => marker.test(line))) {
      const slice = lines.slice(Math.max(0, index - 2), index + 12).join("\n");
      if (!isUnreliableCompileError(slice)) {
        return slice.trim();
      }
    }
  }
  return null;
}

async function readRemoteDevLog(sessionId: string): Promise<string> {
  const sandbox = await getOrCreateDaytonaSandbox(sessionId);
  try {
    return await sandbox.fs.readTextFile(".next/dev/logs/next-development.log");
  } catch {
    return "";
  }
}

async function hasRemoteNodeModules(sessionId: string): Promise<boolean> {
  const sandbox = await getOrCreateDaytonaSandbox(sessionId);
  try {
    await sandbox.fs.getFileDetails("node_modules/next/package.json");
    return true;
  } catch {
    return false;
  }
}

async function hasRemotePackageJson(sessionId: string): Promise<boolean> {
  const sandbox = await getOrCreateDaytonaSandbox(sessionId);
  try {
    await sandbox.fs.getFileDetails("package.json");
    return true;
  } catch {
    return false;
  }
}

async function runRemoteInstall(sessionId: string): Promise<boolean> {
  const sandbox = await getOrCreateDaytonaSandbox(sessionId);
  const pm = resolvePackageManager("daytona");
  logDaytonaBootstrap(sessionId, "preview", `running ${pm.install}`);
  const result = await sandbox.process.executeCommand(pm.install, ".", undefined, 600);
  if (result.exitCode !== 0) {
    const detail =
      (result.stdout || result.stderr || "").trim() || "unknown install failure";
    const message = `pnpm install failed: ${detail.slice(-2000)}`;
    logDaytonaBootstrap(sessionId, "preview", `install failed (exit ${result.exitCode})`);
    daytonaBuildErrors.set(sessionId, message);
    daytonaStates.set(sessionId, {
      status: "error",
      port: getDevPort(),
      devSessionId: `preview-${sessionId}`,
      error: message,
    });
    return false;
  }
  logDaytonaBootstrap(sessionId, "preview", "dependencies installed");
  return hasRemoteNodeModules(sessionId);
}

async function startRemoteDevServer(sessionId: string): Promise<PreviewStatus> {
  const sandbox = await getOrCreateDaytonaSandbox(sessionId);
  const sdkSandbox = sandbox.sdkSandbox;
  const port = getDevPort();
  const pm = resolvePackageManager("daytona");
  const devSessionId = `preview-${sessionId}`;

  logDaytonaBootstrap(
    sessionId,
    "preview",
    `starting dev server on port ${port} (${pm.dev(port)})`,
  );

  daytonaStates.set(sessionId, {
    status: "starting",
    port,
    devSessionId,
  });

  try {
    await sdkSandbox.process.deleteSession(devSessionId);
  } catch {
    // Session may not exist yet.
  }

  await sdkSandbox.process.createSession(devSessionId);

  const devCmd = pm.dev(port);
  const started = await sdkSandbox.process.executeSessionCommand(
    devSessionId,
    {
      command: `cd ${JSON.stringify(DAYTONA_WORKSPACE_ROOT)} && ${devCmd}`,
      runAsync: true,
    },
    30,
  );

  // runAsync=true: exitCode is not meaningful here — poll preview link instead.

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const preview = await sdkSandbox.getPreviewLink(port);
      const probe = await fetch(preview.url, {
        headers: { "x-daytona-preview-token": preview.token },
        signal: AbortSignal.timeout(5_000),
      });

      if (probe.status < 600) {
        daytonaStates.set(sessionId, {
          status: "ready",
          url: preview.url,
          token: preview.token,
          port,
          devSessionId,
        });
        logDaytonaBootstrap(sessionId, "preview", `ready ${preview.url}`);
        return { status: "ready", url: preview.url, port };
      }
    } catch {
      // Dev server still warming up.
    }

    if (started.cmdId) {
      try {
        const logs = await sdkSandbox.process.getSessionCommandLogs(
          devSessionId,
          started.cmdId,
        );
        if (logs.stdout) {
          recordDaytonaOutput(sessionId, logs.stdout);
        }
        if (logs.stderr) {
          recordDaytonaOutput(sessionId, logs.stderr);
        }
      } catch {
        // Logs not ready yet.
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  const error = "Timed out waiting for Daytona preview to become ready";
  logDaytonaBootstrap(sessionId, "preview", error);
  daytonaStates.set(sessionId, {
    status: "error",
    port,
    devSessionId,
    error,
  });
  return { status: "error", error };
}

async function bootstrapDaytonaPreview(sessionId: string): Promise<void> {
  logDaytonaBootstrap(sessionId, "preview", "bootstrap started");
  if (!(await hasRemotePackageJson(sessionId))) {
    logDaytonaBootstrap(sessionId, "preview", "waiting for package.json in workspace");
    daytonaStates.set(sessionId, {
      status: "needs_install",
      port: getDevPort(),
      devSessionId: `preview-${sessionId}`,
    });
    return;
  }

  if (!(await hasRemoteNodeModules(sessionId))) {
    logDaytonaBootstrap(sessionId, "preview", "node_modules missing — installing");
    daytonaStates.set(sessionId, {
      status: "installing",
      port: getDevPort(),
      devSessionId: `preview-${sessionId}`,
    });
    const installed = await runRemoteInstall(sessionId);
    if (!installed) {
      return;
    }
  } else {
    logDaytonaBootstrap(sessionId, "preview", "node_modules present — skipping install");
  }

  await startRemoteDevServer(sessionId);
}

const DAYTONA_BOOTSTRAP_WAIT_MS = 300_000;

async function waitForDaytonaBootstrap(
  sessionId: string,
  maxWaitMs = DAYTONA_BOOTSTRAP_WAIT_MS,
): Promise<void> {
  const pending = daytonaBootstrapPromises.get(sessionId);
  if (!pending) {
    return;
  }
  await Promise.race([
    pending.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, maxWaitMs)),
  ]);
}

function kickOffDaytonaBootstrap(sessionId: string): void {
  if (daytonaBootstrapPromises.has(sessionId)) {
    return;
  }

  logDaytonaBootstrap(sessionId, "preview", "background bootstrap queued");
  const promise = bootstrapDaytonaPreview(sessionId).finally(() => {
    daytonaBootstrapPromises.delete(sessionId);
  });
  daytonaBootstrapPromises.set(sessionId, promise);
}

export function ensureDaytonaPreviewBootstrap(sessionId: string): void {
  kickOffDaytonaBootstrap(sessionId);
}

export async function stopDaytonaDevServer(sessionId: string): Promise<void> {
  const state = daytonaStates.get(sessionId);
  const sdkSandbox = getManagedDaytonaSdkSandbox(sessionId);

  if (sdkSandbox && state?.devSessionId) {
    try {
      await sdkSandbox.process.deleteSession(state.devSessionId);
    } catch {
      // Best effort.
    }
  }

  daytonaStates.delete(sessionId);
  daytonaBootstrapPromises.delete(sessionId);
  daytonaBuildErrors.delete(sessionId);
  daytonaDevLogs.delete(sessionId);
}

export async function restartDaytonaDevServer(
  sessionId: string,
): Promise<PreviewStatus> {
  await stopDaytonaDevServer(sessionId);

  const sandbox = await getOrCreateDaytonaSandbox(sessionId);
  try {
    await sandbox.process.executeCommand("rm -rf .next", ".", undefined, 60);
  } catch {
    // Best effort cache clear on local workspace.
  }

  return startRemoteDevServer(sessionId);
}

export function getDaytonaPreviewStatus(sessionId: string): PreviewStatus {
  const state = daytonaStates.get(sessionId);
  if (!state) {
    return { status: "stopped" };
  }

  if (state.status === "ready" && state.url) {
    return { status: "ready", url: state.url, port: state.port };
  }

  if (state.status === "starting") {
    return { status: "starting", port: state.port };
  }

  if (state.status === "installing") {
    return { status: "installing" };
  }

  if (state.status === "needs_install") {
    return { status: "needs_install" };
  }

  if (state.status === "error") {
    return { status: "error", error: state.error ?? "Preview error" };
  }

  return { status: "stopped" };
}

export async function resolveDaytonaPreviewStatus(
  sessionId: string,
): Promise<PreviewStatus> {
  let current = getDaytonaPreviewStatus(sessionId);

  if (current.status === "stopped" || current.status === "needs_install") {
    if (await hasRemotePackageJson(sessionId)) {
      kickOffDaytonaBootstrap(sessionId);
    } else {
      return { status: "needs_install" };
    }
  }

  if (
    daytonaBootstrapPromises.has(sessionId) ||
    current.status === "installing" ||
    current.status === "starting"
  ) {
    await waitForDaytonaBootstrap(sessionId);
    current = getDaytonaPreviewStatus(sessionId);
    if (current.status !== "stopped") {
      return current;
    }
  }

  if (await hasRemoteNodeModules(sessionId)) {
    kickOffDaytonaBootstrap(sessionId);
    await waitForDaytonaBootstrap(sessionId);
    return getDaytonaPreviewStatus(sessionId);
  }

  if (await hasRemotePackageJson(sessionId)) {
    kickOffDaytonaBootstrap(sessionId);
    await waitForDaytonaBootstrap(sessionId);
    return getDaytonaPreviewStatus(sessionId);
  }

  return { status: "needs_install" };
}

export interface DaytonaPreviewReport {
  status: PreviewStatus["status"];
  url?: string;
  httpStatus?: number;
  buildError: string | null;
}

export async function getDaytonaPreviewReport(
  sessionId: string,
  options?: { restart?: boolean },
): Promise<DaytonaPreviewReport> {
  if (options?.restart) {
    await restartDaytonaDevServer(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 8_000));
  }

  const resolved = await resolveDaytonaPreviewStatus(sessionId);
  let buildError = daytonaBuildErrors.get(sessionId) ?? null;
  let httpStatus: number | undefined;

  if (resolved.status === "error" && !buildError) {
    buildError = resolved.error ?? "Preview failed to start in Daytona sandbox";
  }

  if (resolved.status === "ready" && resolved.url) {
    const state = daytonaStates.get(sessionId);
    try {
      const response = await fetch(resolved.url, {
        headers: state?.token
          ? { "x-daytona-preview-token": state.token }
          : undefined,
        signal: AbortSignal.timeout(5_000),
      });
      httpStatus = response.status;
    } catch {
      httpStatus = 503;
    }

    const devLog = await readRemoteDevLog(sessionId);
    const logError = extractCompileErrorFromLog(devLog);
    if (logError) {
      buildError = logError;
    }

    if (!buildError && httpStatus !== undefined && httpStatus >= 500) {
      buildError =
        logError ??
        `Preview returned HTTP ${httpStatus} but no compile error was captured.`;
    }

    if (buildError) {
      daytonaBuildErrors.set(sessionId, buildError);
    } else {
      daytonaBuildErrors.delete(sessionId);
    }
  }

  return {
    status: resolved.status,
    url: resolved.status === "ready" ? resolved.url : undefined,
    httpStatus,
    buildError,
  };
}

export async function destroyDaytonaPreview(sessionId: string): Promise<void> {
  await stopDaytonaDevServer(sessionId);
  await destroyDaytonaSandbox(sessionId);
}
