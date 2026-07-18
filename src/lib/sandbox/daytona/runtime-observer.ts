/**
 * Observe remote Daytona reality — no persistence orchestration.
 */

import type { Sandbox } from "@daytona/sdk";

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
import { isAsleep, reconnectSandbox, wrapSandbox } from "./vm";

const SIGNED_TTL_SEC = 3600;
const SIGNED_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 15_000;

export interface ObservedRuntime {
  phase: DaytonaObservedPhase;
  sandboxId: string | null;
  sandboxState: string | null;
  hasPackageJson: boolean;
  hasNodeModules: boolean;
  previewUrl: string | null;
  previewPort: number | null;
  previewExpiresAtMs: number | null;
  probeUrl: string | null;
  previewToken: string | null;
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
    previewExpiresAtMs: null,
    probeUrl: null,
    previewToken: null,
    buildError: null,
    httpStatus: null,
    lastError,
  };
}

/**
 * Mint or reuse a stable signed embed URL; returns cache fields for runtime store.
 */
export async function resolveSignedEmbedUrl(
  snapshot: DaytonaRuntimeSnapshot,
  sdk: Sandbox,
  port: number,
): Promise<{
  url: string;
  expiresAtMs: number;
} | null> {
  const now = Date.now();
  if (
    snapshot.previewUrl &&
    snapshot.sandboxId === sdk.id &&
    snapshot.previewPort === port &&
    snapshot.previewExpiresAtMs != null &&
    snapshot.previewExpiresAtMs - SIGNED_REFRESH_BUFFER_MS > now
  ) {
    return {
      url: snapshot.previewUrl,
      expiresAtMs: snapshot.previewExpiresAtMs,
    };
  }

  try {
    const signed = await sdk.getSignedPreviewUrl(port, SIGNED_TTL_SEC);
    return {
      url: signed.url,
      expiresAtMs: now + SIGNED_TTL_SEC * 1000,
    };
  } catch {
    return null;
  }
}

async function probePreviewLink(
  sandbox: DaytonaProjectSandbox,
  snapshot: DaytonaRuntimeSnapshot,
): Promise<{
  ready: boolean;
  url: string | null;
  port: number;
  expiresAtMs: number | null;
  probeUrl: string | null;
  token: string | null;
  http: number | null;
}> {
  const sdk = sandbox.sdkSandbox;
  const port = getDaytonaDevPort();

  try {
    const preview = await sdk.getPreviewLink(port);
    const res = await fetch(preview.url, {
      headers: { "x-daytona-preview-token": preview.token },
      signal: AbortSignal.timeout(5_000),
    });

    if (res.status >= 600) {
      return {
        ready: false,
        url: null,
        port,
        expiresAtMs: null,
        probeUrl: preview.url,
        token: preview.token,
        http: res.status,
      };
    }

    const embed = await resolveSignedEmbedUrl(snapshot, sdk, port);
    return {
      ready: true,
      url: embed?.url ?? preview.url,
      port,
      expiresAtMs: embed?.expiresAtMs ?? null,
      probeUrl: preview.url,
      token: preview.token,
      http: res.status,
    };
  } catch {
    return {
      ready: false,
      url: null,
      port,
      expiresAtMs: null,
      probeUrl: null,
      token: null,
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

    const preview = await probePreviewLink(project, snapshot);
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
        previewExpiresAtMs: preview.expiresAtMs,
        probeUrl: preview.probeUrl,
        previewToken: preview.token,
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
      previewToken: preview.token,
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
  let http = await httpStatus(observed.probeUrl, observed.previewToken ?? undefined);
  let buildError = extractCompileError(await readDevLog(project));

  if (!buildError && http < 500) {
    buildError = null;
  } else if (!buildError && http >= 500) {
    await new Promise((r) => setTimeout(r, 2_000));
    http = await httpStatus(observed.probeUrl, observed.previewToken ?? undefined);
    buildError =
      http < 500
        ? null
        : `Preview returned HTTP ${http} but no compile error was captured.`;
  }

  return { httpStatus: http, buildError };
}
