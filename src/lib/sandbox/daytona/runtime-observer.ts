/**
 * Observe remote Daytona reality — no persistence orchestration.
 */

import { logDaytonaBootstrap } from "./bootstrap-log";
import { getDaytonaDevPort } from "./config";
import {
  extractCompileError,
  httpStatus,
  readDevLog,
  remoteFileExists,
} from "./app-server-health";
import type { DaytonaProjectSandbox } from "./provider";
import {
  type DaytonaObservedPhase,
  type DaytonaRuntimeSnapshot,
} from "./runtime-state";
import { getRuntimeSnapshot } from "./runtime-store";
import { ensureSandboxPublic, isAsleep, reconnectSandbox, wrapSandbox } from "./vm";

const PROBE_TIMEOUT_MS = 15_000;

export interface ObservedRuntime {
  phase: DaytonaObservedPhase;
  sandboxId: string | null;
  sandboxState: string | null;
  hasPackageJson: boolean;
  hasNodeModules: boolean;
  previewUrl: string | null;
  previewPort: number | null;
  probeUrl: string | null;
  buildError: string | null;
  httpStatus: number | null;
  lastError: string | null;
}

function emptyObserved(lastError: string | null = null): ObservedRuntime {
  return {
    phase: "missing",
    sandboxId: null,
    sandboxState: null,
    hasPackageJson: false,
    hasNodeModules: false,
    previewUrl: null,
    previewPort: null,
    probeUrl: null,
    buildError: null,
    httpStatus: null,
    lastError,
  };
}

/**
 * Probe public getPreviewLink URL (no signed embed / token).
 * Ensures the sandbox is public so the iframe can load without auth headers.
 */
async function probePreviewLink(
  sandbox: DaytonaProjectSandbox,
): Promise<{
  ready: boolean;
  url: string | null;
  port: number;
  probeUrl: string | null;
  http: number | null;
}> {
  const sdk = sandbox.sdkSandbox;
  const port = getDaytonaDevPort();

  try {
    await ensureSandboxPublic(sdk);
    const preview = await sdk.getPreviewLink(port);
    const res = await fetch(preview.url, {
      signal: AbortSignal.timeout(5_000),
    });

    if (res.status >= 500) {
      return {
        ready: false,
        url: preview.url,
        port,
        probeUrl: preview.url,
        http: res.status,
      };
    }

    return {
      ready: true,
      url: preview.url,
      port,
      probeUrl: preview.url,
      http: res.status,
    };
  } catch {
    return {
      ready: false,
      url: null,
      port,
      probeUrl: null,
      http: null,
    };
  }
}

/**
 * Peek running preview without waking a stopped sandbox.
 */
export async function observeRuntime(
  sessionId: string,
  options?: { wake?: boolean; snapshot?: DaytonaRuntimeSnapshot },
): Promise<ObservedRuntime> {
  const wake = options?.wake ?? false;
  const snapshot = options?.snapshot ?? (await getRuntimeSnapshot(sessionId));

  if (!snapshot.sandboxId) {
    return emptyObserved();
  }

  const run = async (): Promise<ObservedRuntime> => {
    const sdk = await reconnectSandbox(sessionId, snapshot.sandboxId!, wake);
    if (!sdk) {
      // Stored id may be gone, or asleep when wake=false.
      try {
        const { getDaytonaClient } = await import("./client");
        const peek = await getDaytonaClient().get(snapshot.sandboxId!);
        if (isAsleep(peek.state) && !wake) {
          return {
            ...emptyObserved(),
            phase: "workspace-ready",
            sandboxId: snapshot.sandboxId,
            sandboxState: peek.state ?? null,
          };
        }
      } catch {
        return emptyObserved();
      }
      return emptyObserved();
    }

    const project = wrapSandbox(sessionId, sdk);
    const [hasPackageJson, hasNodeModules] = await Promise.all([
      remoteFileExists(project, "package.json"),
      remoteFileExists(project, "node_modules/next/package.json"),
    ]);

    if (!hasPackageJson) {
      return {
        ...emptyObserved(),
        phase: "bootstrapping-workspace",
        sandboxId: sdk.id,
        sandboxState: sdk.state ?? null,
        hasPackageJson: false,
        hasNodeModules: false,
      };
    }

    const preview = await probePreviewLink(project);
    let buildError: string | null = null;
    if (preview.ready) {
      buildError = extractCompileError(await readDevLog(project));
      logDaytonaBootstrap(sessionId, "preview", `ready ${preview.probeUrl}`);
      return {
        phase: "preview-ready",
        sandboxId: sdk.id,
        sandboxState: sdk.state ?? null,
        hasPackageJson,
        hasNodeModules,
        previewUrl: preview.url,
        previewPort: preview.port,
        probeUrl: preview.probeUrl,
        buildError,
        httpStatus: preview.http,
        lastError: null,
      };
    }

    if (!hasNodeModules) {
      return {
        ...emptyObserved(),
        phase: "workspace-ready",
        sandboxId: sdk.id,
        sandboxState: sdk.state ?? null,
        hasPackageJson,
        hasNodeModules: false,
      };
    }

    return {
      ...emptyObserved(),
      phase: "workspace-ready",
      sandboxId: sdk.id,
      sandboxState: sdk.state ?? null,
      hasPackageJson,
      hasNodeModules,
      previewPort: getDaytonaDevPort(),
      probeUrl: preview.probeUrl,
      httpStatus: preview.http,
    };
  };

  try {
    return await Promise.race([
      run(),
      new Promise<ObservedRuntime>((resolve) =>
        setTimeout(() => resolve(emptyObserved("observe timeout")), PROBE_TIMEOUT_MS),
      ),
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logDaytonaBootstrap(
      sessionId,
      "preview",
      `observe failed: ${detail.slice(0, 160)}`,
    );
    return emptyObserved(detail.slice(0, 500));
  }
}

/** HTTP + compile check against an already-observed ready preview. */
export async function observePreviewHealth(
  sessionId: string,
  observed: ObservedRuntime,
): Promise<{ httpStatus: number; buildError: string | null }> {
  if (!observed.probeUrl || !observed.sandboxId) {
    return { httpStatus: 503, buildError: null };
  }

  const sdk = await reconnectSandbox(sessionId, observed.sandboxId, false);
  if (!sdk) {
    return { httpStatus: 503, buildError: null };
  }

  const project = wrapSandbox(sessionId, sdk);
  let http = await httpStatus(observed.probeUrl);
  let buildError = extractCompileError(await readDevLog(project));

  if (!buildError && http < 500) {
    buildError = null;
  } else if (!buildError && http >= 500) {
    await new Promise((r) => setTimeout(r, 2_000));
    http = await httpStatus(observed.probeUrl);
    buildError =
      http < 500
        ? null
        : `Preview returned HTTP ${http} but no compile error was captured.`;
  }

  return { httpStatus: http, buildError };
}
