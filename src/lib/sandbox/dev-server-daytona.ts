import type { PreviewStatus } from "./dev-server";
import { isUnreliableCompileError } from "./dev-server";
import { logDaytonaBootstrap } from "./daytona/bootstrap-log";
import { getDaytonaDevPort, DAYTONA_WORKSPACE_ROOT } from "./daytona/config";
import {
  destroyDaytonaSandbox,
  dropManagedSandboxCache,
  getExistingDaytonaSandbox,
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
  /** Standard preview URL — requires `x-daytona-preview-token` for fetch. */
  url?: string;
  token?: string;
  /** Signed preview URL for browser/iframe (token embedded; no custom headers). */
  embedUrl?: string;
  /** Epoch ms when embedUrl should be refreshed. */
  embedUrlExpiresAt?: number;
  port: number;
  error?: string;
  devSessionId: string;
}

const SIGNED_PREVIEW_TTL_SECONDS = 3600;
const SIGNED_PREVIEW_REFRESH_BUFFER_MS = 5 * 60_000;
/** Cap adopt work on UI poll requests so cold isolates stay responsive. */
const ADOPT_TIMEOUT_MS = 15_000;

const daytonaStates = new Map<string, DaytonaPreviewState>();
const daytonaBootstrapPromises = new Map<string, Promise<void>>();
const daytonaBuildErrors = new Map<string, string>();
const daytonaDevLogs = new Map<string, string>();
/** Bumped when preview memory is cleared so in-flight bootstraps cannot clobber newer state. */
const daytonaBootstrapEpoch = new Map<string, number>();

export function getDaytonaBuildError(sessionId: string): string | null {
  return daytonaBuildErrors.get(sessionId) ?? null;
}

function bumpBootstrapEpoch(sessionId: string): number {
  const next = (daytonaBootstrapEpoch.get(sessionId) ?? 0) + 1;
  daytonaBootstrapEpoch.set(sessionId, next);
  return next;
}

function isBootstrapCurrent(sessionId: string, epoch: number): boolean {
  return (daytonaBootstrapEpoch.get(sessionId) ?? 0) === epoch;
}

/**
 * Drop in-process preview Maps so the next resolve behaves like a cold isolate.
 * Does not stop the remote `pnpm dev` or touch volume persistence.
 */
export function clearDaytonaPreviewMemory(sessionId?: string): void {
  if (sessionId) {
    bumpBootstrapEpoch(sessionId);
    daytonaStates.delete(sessionId);
    daytonaBootstrapPromises.delete(sessionId);
    daytonaBuildErrors.delete(sessionId);
    daytonaDevLogs.delete(sessionId);
    return;
  }
  daytonaBootstrapEpoch.clear();
  daytonaStates.clear();
  daytonaBootstrapPromises.clear();
  daytonaBuildErrors.clear();
  daytonaDevLogs.clear();
}

function getDevPort(): number {
  return getDaytonaDevPort();
}

/**
 * Re-attach to an already-running remote preview without creating a sandbox.
 * Observe path only — provision belongs to agent turn / POST start.
 */
async function tryAdoptExistingDaytonaPreview(
  sessionId: string,
): Promise<PreviewStatus | null> {
  const adopt = async (): Promise<PreviewStatus | null> => {
    const sandbox = await getExistingDaytonaSandbox(sessionId);
    if (!sandbox) {
      return null;
    }
    const sdkSandbox = sandbox.sdkSandbox;
    const port = getDevPort();
    const preview = await sdkSandbox.getPreviewLink(port);
    const probe = await fetch(preview.url, {
      headers: { "x-daytona-preview-token": preview.token },
      signal: AbortSignal.timeout(5_000),
    });

    // Match startRemoteDevServer: any completed HTTP response means the proxy is up.
    if (probe.status >= 600) {
      return null;
    }

    let embedUrl: string | undefined;
    let embedUrlExpiresAt: number | undefined;
    try {
      const signed = await sdkSandbox.getSignedPreviewUrl(
        port,
        SIGNED_PREVIEW_TTL_SECONDS,
      );
      embedUrl = signed.url;
      embedUrlExpiresAt = Date.now() + SIGNED_PREVIEW_TTL_SECONDS * 1000;
    } catch {
      // Fall back to standard URL; Web iframe may need a later refresh.
    }

    daytonaStates.set(sessionId, {
      status: "ready",
      url: preview.url,
      token: preview.token,
      embedUrl,
      embedUrlExpiresAt,
      port,
      devSessionId: `preview-${sessionId}`,
    });
    logDaytonaBootstrap(
      sessionId,
      "preview",
      `adopted existing preview ${preview.url} sandbox=${sdkSandbox.id}`,
    );
    return {
      status: "ready",
      url: embedUrl ?? preview.url,
      port,
    };
  };

  try {
    return await Promise.race([
      adopt(),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), ADOPT_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logDaytonaBootstrap(
      sessionId,
      "preview",
      `adopt failed: ${detail.slice(0, 160)}`,
    );
    return null;
  }
}

/** Map Daytona SDK failures to a short UI-facing message. */
export function formatDaytonaBootstrapError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/disk limit exceeded/i.test(raw) || /Total disk limit/i.test(raw)) {
    return "Daytona 磁盘配额已满（上限 30GiB）。请联系作者清理闲置 Sandbox 后再试。";
  }
  const trimmed = raw.trim();
  return trimmed.length > 0
    ? trimmed.slice(0, 500)
    : "Daytona 预览启动失败，请稍后重试或联系作者。";
}

function setDaytonaPreviewError(sessionId: string, error: unknown): void {
  const message = formatDaytonaBootstrapError(error);
  logDaytonaBootstrap(
    sessionId,
    "preview",
    `bootstrap failed: ${message.slice(0, 200)}`,
  );
  daytonaStates.set(sessionId, {
    status: "error",
    port: getDevPort(),
    devSessionId: `preview-${sessionId}`,
    error: message,
  });
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

export async function hasDaytonaNodeModules(sessionId: string): Promise<boolean> {
  const sandbox = await getOrCreateDaytonaSandbox(sessionId);
  try {
    await sandbox.fs.getFileDetails("node_modules/next/package.json");
    return true;
  } catch {
    return false;
  }
}

async function hasRemoteNodeModules(sessionId: string): Promise<boolean> {
  return hasDaytonaNodeModules(sessionId);
}

async function ensureSignedEmbedUrl(
  sessionId: string,
  state: DaytonaPreviewState,
): Promise<string | undefined> {
  if (
    state.embedUrl &&
    state.embedUrlExpiresAt &&
    Date.now() < state.embedUrlExpiresAt - SIGNED_PREVIEW_REFRESH_BUFFER_MS
  ) {
    return state.embedUrl;
  }

  const sdkSandbox = getManagedDaytonaSdkSandbox(sessionId);
  if (!sdkSandbox) {
    return state.embedUrl;
  }

  try {
    const signed = await sdkSandbox.getSignedPreviewUrl(
      state.port,
      SIGNED_PREVIEW_TTL_SECONDS,
    );
    state.embedUrl = signed.url;
    state.embedUrlExpiresAt = Date.now() + SIGNED_PREVIEW_TTL_SECONDS * 1000;
    daytonaStates.set(sessionId, state);
    return signed.url;
  } catch {
    return state.embedUrl ?? state.url;
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

async function startRemoteDevServer(
  sessionId: string,
  epoch: number,
): Promise<PreviewStatus> {
  if (!isBootstrapCurrent(sessionId, epoch)) {
    return { status: "stopped" };
  }

  const sandbox = await getOrCreateDaytonaSandbox(sessionId);
  if (!isBootstrapCurrent(sessionId, epoch)) {
    return { status: "stopped" };
  }

  const sdkSandbox = sandbox.sdkSandbox;
  const port = getDevPort();
  const pm = resolvePackageManager("daytona");
  const devSessionId = `preview-${sessionId}`;

  logDaytonaBootstrap(
    sessionId,
    "preview",
    `starting dev server on port ${port} (${pm.dev(port)}) sandbox=${sdkSandbox.id}`,
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
    if (!isBootstrapCurrent(sessionId, epoch)) {
      return { status: "stopped" };
    }

    try {
      const preview = await sdkSandbox.getPreviewLink(port);
      const probe = await fetch(preview.url, {
        headers: { "x-daytona-preview-token": preview.token },
        signal: AbortSignal.timeout(5_000),
      });

      if (probe.status < 600) {
        if (!isBootstrapCurrent(sessionId, epoch)) {
          return { status: "stopped" };
        }

        let embedUrl: string | undefined;
        let embedUrlExpiresAt: number | undefined;
        try {
          const signed = await sdkSandbox.getSignedPreviewUrl(
            port,
            SIGNED_PREVIEW_TTL_SECONDS,
          );
          embedUrl = signed.url;
          embedUrlExpiresAt = Date.now() + SIGNED_PREVIEW_TTL_SECONDS * 1000;
        } catch {
          // Fall back to standard URL; Web iframe may need a later refresh.
        }

        daytonaStates.set(sessionId, {
          status: "ready",
          url: preview.url,
          token: preview.token,
          embedUrl,
          embedUrlExpiresAt,
          port,
          devSessionId,
        });
        logDaytonaBootstrap(
          sessionId,
          "preview",
          `ready ${preview.url} sandbox=${sdkSandbox.id}`,
        );
        return { status: "ready", url: embedUrl ?? preview.url, port };
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

  if (!isBootstrapCurrent(sessionId, epoch)) {
    return { status: "stopped" };
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

async function bootstrapDaytonaPreview(
  sessionId: string,
  epoch: number,
): Promise<void> {
  if (!isBootstrapCurrent(sessionId, epoch)) {
    return;
  }

  logDaytonaBootstrap(sessionId, "preview", "bootstrap started");
  if (!(await hasRemotePackageJson(sessionId))) {
    if (!isBootstrapCurrent(sessionId, epoch)) {
      return;
    }
    logDaytonaBootstrap(sessionId, "preview", "waiting for package.json in workspace");
    daytonaStates.set(sessionId, {
      status: "needs_install",
      port: getDevPort(),
      devSessionId: `preview-${sessionId}`,
    });
    return;
  }

  if (!(await hasRemoteNodeModules(sessionId))) {
    if (!isBootstrapCurrent(sessionId, epoch)) {
      return;
    }
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

  if (!isBootstrapCurrent(sessionId, epoch)) {
    return;
  }

  // Prefer adopting a healthy remote preview over killing/restarting pnpm.
  const adopted = await tryAdoptExistingDaytonaPreview(sessionId);
  if (adopted?.status === "ready") {
    logDaytonaBootstrap(
      sessionId,
      "preview",
      "bootstrap adopted existing ready preview",
    );
    return;
  }

  await startRemoteDevServer(sessionId, epoch);
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

  const current = daytonaStates.get(sessionId);
  if (!current || current.status === "stopped") {
    daytonaStates.set(sessionId, {
      status: "starting",
      port: getDevPort(),
      devSessionId: `preview-${sessionId}`,
    });
  }

  const epoch = daytonaBootstrapEpoch.get(sessionId) ?? bumpBootstrapEpoch(sessionId);
  logDaytonaBootstrap(
    sessionId,
    "preview",
    `background bootstrap queued (epoch=${epoch})`,
  );
  const promise = bootstrapDaytonaPreview(sessionId, epoch)
    .catch((error) => {
      if (isBootstrapCurrent(sessionId, epoch)) {
        setDaytonaPreviewError(sessionId, error);
      }
    })
    .finally(() => {
      if (daytonaBootstrapPromises.get(sessionId) === promise) {
        daytonaBootstrapPromises.delete(sessionId);
      }
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

  clearDaytonaPreviewMemory(sessionId);
}

export async function restartDaytonaDevServer(
  sessionId: string,
): Promise<PreviewStatus> {
  await stopDaytonaDevServer(sessionId);

  try {
    const sandbox = await getOrCreateDaytonaSandbox(sessionId);
    try {
      await sandbox.process.executeCommand("rm -rf .next", ".", undefined, 60);
    } catch {
      // Best effort cache clear on local workspace.
    }

    const epoch = bumpBootstrapEpoch(sessionId);
    return await startRemoteDevServer(sessionId, epoch);
  } catch (error) {
    setDaytonaPreviewError(sessionId, error);
    return {
      status: "error",
      error: formatDaytonaBootstrapError(error),
    };
  }
}

export function getDaytonaPreviewStatus(sessionId: string): PreviewStatus {
  const state = daytonaStates.get(sessionId);
  if (!state) {
    return { status: "stopped" };
  }

  if (state.status === "ready" && (state.embedUrl || state.url)) {
    return {
      status: "ready",
      url: state.embedUrl ?? state.url!,
      port: state.port,
    };
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

async function withFreshEmbedUrl(
  sessionId: string,
  status: PreviewStatus,
): Promise<PreviewStatus> {
  if (status.status !== "ready") {
    return status;
  }

  const state = daytonaStates.get(sessionId);
  if (!state || state.status !== "ready") {
    return status;
  }

  const embedUrl = await ensureSignedEmbedUrl(sessionId, state);
  if (!embedUrl) {
    return status;
  }

  return { status: "ready", url: embedUrl, port: state.port };
}

/** Extract Daytona sandbox id from `https://3000-{id}.daytonaproxy….net`. */
function sandboxIdFromPreviewUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    const match = host.match(/^\d+-([a-z0-9]+)\./i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * If another isolate claimed a different sandbox, drop stale preview memory
 * so the next bootstrap targets the authoritative id.
 */
async function invalidatePreviewIfSandboxDrifted(
  sessionId: string,
): Promise<boolean> {
  const state = daytonaStates.get(sessionId);
  if (!state || state.status !== "ready" || !state.url) {
    return false;
  }

  try {
    const { getSession } = await import("@/lib/session/store");
    const session = await getSession(sessionId);
    const authoritativeId = session?.daytonaSandboxId;
    if (!authoritativeId) {
      return false;
    }

    const managedId = getManagedDaytonaSdkSandbox(sessionId)?.id;
    const urlId = sandboxIdFromPreviewUrl(state.url);
    const drifted =
      (managedId && managedId !== authoritativeId) ||
      (urlId && urlId !== authoritativeId);

    if (!drifted) {
      return false;
    }

    logDaytonaBootstrap(
      sessionId,
      "preview",
      `sandbox drift detected (url=${urlId ?? "?"}, managed=${managedId ?? "?"}, session=${authoritativeId}) — clearing preview memory`,
    );
    dropManagedSandboxCache(sessionId);
    clearDaytonaPreviewMemory(sessionId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Observe-only: read memory / adopt existing preview. Never create sandbox or
 * kick off bootstrap (UI GET /preview and session hydrate).
 */
export async function observeDaytonaPreviewStatus(
  sessionId: string,
): Promise<PreviewStatus> {
  // Local diagnostic: forget in-memory preview URL like a new Vercel isolate.
  try {
    const { simulatePreviewColdIsolate } = await import(
      "@/lib/browser-run/config"
    );
    if (simulatePreviewColdIsolate()) {
      clearDaytonaPreviewMemory(sessionId);
    }
  } catch {
    // config is always available in host app; ignore if tree-shaken oddly
  }

  await invalidatePreviewIfSandboxDrifted(sessionId);

  const current = getDaytonaPreviewStatus(sessionId);

  if (current.status === "ready") {
    return withFreshEmbedUrl(sessionId, current);
  }

  if (current.status === "error") {
    return current;
  }

  if (
    current.status === "installing" ||
    current.status === "starting"
  ) {
    if (!daytonaBootstrapPromises.has(sessionId)) {
      const adopted = await tryAdoptExistingDaytonaPreview(sessionId);
      if (adopted?.status === "ready") {
        return adopted;
      }
    }
    return current;
  }

  // Cold isolate / stopped: rediscover via session.daytonaSandboxId only.
  const adopted = await tryAdoptExistingDaytonaPreview(sessionId);
  if (adopted?.status === "ready") {
    return adopted;
  }

  return current.status === "needs_install"
    ? current
    : { status: "stopped" };
}

/**
 * Provision path for checkPreview / ensureDevServer: kick off bootstrap then
 * optionally wait. UI polls must use observeDaytonaPreviewStatus instead.
 */
export async function resolveDaytonaPreviewStatus(
  sessionId: string,
  options?: { wait?: boolean },
): Promise<PreviewStatus> {
  const wait = options?.wait ?? true;

  if (!wait) {
    return observeDaytonaPreviewStatus(sessionId);
  }

  const current = await observeDaytonaPreviewStatus(sessionId);
  if (current.status === "ready" || current.status === "error") {
    return current;
  }

  kickOffDaytonaBootstrap(sessionId);
  await waitForDaytonaBootstrap(sessionId);
  return withFreshEmbedUrl(sessionId, getDaytonaPreviewStatus(sessionId));
}

export async function ensureDaytonaDevServer(
  sessionId: string,
): Promise<PreviewStatus> {
  ensureDaytonaPreviewBootstrap(sessionId);
  const observed = await observeDaytonaPreviewStatus(sessionId);
  if (observed.status === "stopped" || observed.status === "needs_install") {
    return { status: "starting", port: getDevPort() };
  }
  return observed;
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
    // Probe with the standard preview URL + token (not the signed embed URL).
    const probeUrl = state?.url ?? resolved.url;

    const probeOnce = async (): Promise<number> => {
      try {
        const response = await fetch(probeUrl, {
          headers: state?.token
            ? { "x-daytona-preview-token": state.token }
            : undefined,
          signal: AbortSignal.timeout(5_000),
        });
        return response.status;
      } catch {
        return 503;
      }
    };

    httpStatus = await probeOnce();

    const devLog = await readRemoteDevLog(sessionId);
    const logError = extractCompileErrorFromLog(devLog);

    // Live probe wins over a stale in-memory error (common after Daytona proxy
    // cold-start 502s). A healthy response with no compile marker clears the gate.
    if (logError) {
      buildError = logError;
    } else if (httpStatus < 500) {
      buildError = null;
    } else {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      httpStatus = await probeOnce();
      if (httpStatus < 500) {
        buildError = null;
      } else {
        buildError = `Preview returned HTTP ${httpStatus} but no compile error was captured.`;
      }
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
