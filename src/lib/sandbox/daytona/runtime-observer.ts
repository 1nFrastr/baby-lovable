/**
 * Observe remote Daytona reality — no persistence orchestration.
 * Snapshot already has starter + pnpm + node_modules; no seed / package.json probe.
 */

import { logDaytonaBootstrap, logDaytonaTiming } from "./bootstrap-log";
import { getDaytonaDevPort } from "./config";
import {
  extractCompileError,
  httpStatus,
  PREVIEW_HTTP_TIMEOUT_MS,
  readDevLog,
} from "./app-server-health";
import type { DaytonaProjectSandbox } from "./provider";
import {
  type DaytonaObservedPhase,
  type DaytonaRuntimeSnapshot,
} from "./runtime-state";
import { getRuntimeSnapshot } from "./runtime-store";
import { ensureSandboxPublic, isAsleep, reconnectSandbox, wrapSandbox } from "./vm";

/** Soft deadline for a full observe pass (reconnect + short HTTP). */
const PROBE_TIMEOUT_MS = 8_000;
/** After soft deadline, wait this long for the in-flight pass to finish. */
const PROBE_GRACE_MS = 3_000;

/** In-flight observe per session — coalesce instead of stacking reconnects. */
const inFlightObserve = new Map<string, Promise<ObservedRuntime>>();
/** Ready result that finished after a soft-timeout return — next tick adopts it. */
const lateReadyMailbox = new Map<string, ObservedRuntime>();

export interface ObservedRuntime {
  phase: DaytonaObservedPhase;
  sandboxId: string | null;
  sandboxState: string | null;
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
    previewUrl: null,
    previewPort: null,
    probeUrl: null,
    buildError: null,
    httpStatus: null,
    lastError,
  };
}

/** Soft timeout that does not look like "sandbox gone". */
function softTimeoutObserved(snapshot: DaytonaRuntimeSnapshot): ObservedRuntime {
  return {
    phase: "workspace-ready",
    sandboxId: snapshot.sandboxId,
    sandboxState: null,
    previewUrl: snapshot.previewUrl,
    previewPort: snapshot.previewPort ?? getDaytonaDevPort(),
    probeUrl: snapshot.previewUrl,
    buildError: null,
    httpStatus: null,
    lastError: "observe timeout",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Probe public getPreviewLink URL (no signed embed / token).
 * Short HTTP timeout: hang ≈ not ready (expect 502 / connection fail while Next boots).
 */
async function probePreviewLink(
  sandbox: DaytonaProjectSandbox,
  cachedUrl?: string | null,
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
    let url = cachedUrl ?? null;
    if (!url) {
      await ensureSandboxPublic(sdk);
      const preview = await sdk.getPreviewLink(port);
      url = preview.url;
    }

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(PREVIEW_HTTP_TIMEOUT_MS),
      });

      if (res.status >= 500) {
        return {
          ready: false,
          url,
          port,
          probeUrl: url,
          http: res.status,
        };
      }

      return {
        ready: true,
        url,
        port,
        probeUrl: url,
        http: res.status,
      };
    } catch {
      // Timeout / connection refused while Next boots — keep URL, not ready.
      return {
        ready: false,
        url,
        port,
        probeUrl: url,
        http: null,
      };
    }
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

async function runObserve(
  sessionId: string,
  snapshot: DaytonaRuntimeSnapshot,
  wake: boolean,
): Promise<ObservedRuntime> {
  const t0 = Date.now();
  const sdk = await reconnectSandbox(sessionId, snapshot.sandboxId!, wake);
  logDaytonaTiming(
    sessionId,
    "observe.reconnect",
    Date.now() - t0,
    `wake=${wake} ok=${Boolean(sdk)}`,
  );
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
  const tProbe = Date.now();
  const preview = await probePreviewLink(project, snapshot.previewUrl);
  logDaytonaTiming(
    sessionId,
    "observe.probePreview",
    Date.now() - tProbe,
    `ready=${preview.ready} http=${preview.http ?? "null"}`,
  );
  if (preview.ready) {
    logDaytonaBootstrap(sessionId, "preview", `ready ${preview.probeUrl}`);
    logDaytonaTiming(sessionId, "observe.total", Date.now() - t0, "preview-ready");
    return {
      phase: "preview-ready",
      sandboxId: sdk.id,
      sandboxState: sdk.state ?? null,
      previewUrl: preview.url,
      previewPort: preview.port,
      probeUrl: preview.probeUrl,
      // Compile log is owned by write/edit peek — keep observe cheap.
      buildError: null,
      httpStatus: preview.http,
      lastError: null,
    };
  }

  logDaytonaTiming(
    sessionId,
    "observe.total",
    Date.now() - t0,
    `workspace-ready http=${preview.http ?? "null"}`,
  );
  return {
    ...emptyObserved(),
    phase: "workspace-ready",
    sandboxId: sdk.id,
    sandboxState: sdk.state ?? null,
    previewUrl: preview.url,
    previewPort: preview.port,
    probeUrl: preview.probeUrl,
    httpStatus: preview.http,
  };
}

/**
 * Wait for an observe pass with soft deadline + grace adopt.
 * Does not cancel the underlying pass — late ready is mailed for the next tick.
 */
async function awaitWithSoftDeadline(
  sessionId: string,
  runPromise: Promise<ObservedRuntime>,
  snapshot: DaytonaRuntimeSnapshot,
): Promise<ObservedRuntime> {
  const tRace = Date.now();

  const raced = await Promise.race([
    runPromise.then((value) => ({ kind: "done" as const, value })),
    sleep(PROBE_TIMEOUT_MS).then(() => ({ kind: "timeout" as const })),
  ]);

  if (raced.kind === "done") {
    return raced.value;
  }

  logDaytonaTiming(
    sessionId,
    "observe.softTimeout",
    Date.now() - tRace,
    "waiting-grace",
  );
  const late = await Promise.race([
    runPromise.then((value) => ({ kind: "done" as const, value })),
    sleep(PROBE_GRACE_MS).then(() => ({ kind: "timeout" as const })),
  ]);

  if (late.kind === "done") {
    logDaytonaTiming(
      sessionId,
      "observe.total",
      Date.now() - tRace,
      `adopted-after-soft-timeout phase=${late.value.phase}`,
    );
    return late.value;
  }

  logDaytonaTiming(
    sessionId,
    "observe.total",
    Date.now() - tRace,
    "TIMEOUT kept-sandbox",
  );

  // Do not cancel — if this pass still finishes ready, next observe adopts it.
  void runPromise.then((value) => {
    if (value.phase === "preview-ready") {
      lateReadyMailbox.set(sessionId, value);
      logDaytonaTiming(
        sessionId,
        "observe.lateMailbox",
        0,
        `stashed phase=${value.phase}`,
      );
    }
  });

  return softTimeoutObserved(snapshot);
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

  const mailed = lateReadyMailbox.get(sessionId);
  if (mailed?.phase === "preview-ready") {
    lateReadyMailbox.delete(sessionId);
    logDaytonaTiming(sessionId, "observe.total", 0, "adopted-late-mailbox");
    return mailed;
  }

  const existing = inFlightObserve.get(sessionId);
  if (existing) {
    logDaytonaTiming(sessionId, "observe.coalesce", 0, "join-in-flight");
    try {
      return await awaitWithSoftDeadline(sessionId, existing, snapshot);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return emptyObserved(detail.slice(0, 500));
    }
  }

  const runPromise = runObserve(sessionId, snapshot, wake).finally(() => {
    if (inFlightObserve.get(sessionId) === runPromise) {
      inFlightObserve.delete(sessionId);
    }
  });
  inFlightObserve.set(sessionId, runPromise);

  try {
    return await awaitWithSoftDeadline(sessionId, runPromise, snapshot);
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

/** @internal test helper — clear coalesce / mailbox state. */
export function resetObserveRuntimeForTests(): void {
  inFlightObserve.clear();
  lateReadyMailbox.clear();
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
