/**
 * Observe remote Daytona reality — no persistence orchestration.
 * Snapshot already has starter + pnpm + node_modules; no seed / package.json probe.
 */

import { logDaytonaBootstrap, logDaytonaTiming } from "./bootstrap-log";
import { getDaytonaDevPort } from "./config";
import { PREVIEW_HTTP_TIMEOUT_MS } from "./app-server-health";
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

interface ObserveIdentity {
  sessionId: string;
  sandboxId: string;
  generation: number;
  wake: boolean;
}

interface InFlightObserve extends ObserveIdentity {
  promise: Promise<ObservedRuntime>;
}

interface LateReadyObserve extends ObserveIdentity {
  value: ObservedRuntime;
}

/**
 * Coalesce only equivalent observations. Passive peeks must not suppress a
 * wake request, and results from an old sandbox generation must not leak into
 * a replacement runtime.
 */
const inFlightObserve = new Map<string, InFlightObserve>();
/** Ready result that finished after a soft-timeout return — next tick adopts it. */
const lateReadyMailbox = new Map<string, LateReadyObserve>();

export interface ObservedRuntime {
  phase: DaytonaObservedPhase;
  sandboxId: string | null;
  sandboxState: string | null;
  previewUrl: string | null;
  previewPort: number | null;
  probeUrl: string | null;
  httpStatus: number | null;
  lastError: string | null;
  /** The failure is inconclusive and must not clobber known-good durable state. */
  transient?: boolean;
}

function emptyObserved(
  lastError: string | null = null,
  transient = false,
): ObservedRuntime {
  return {
    phase: "missing",
    sandboxId: null,
    sandboxState: null,
    previewUrl: null,
    previewPort: null,
    probeUrl: null,
    httpStatus: null,
    lastError,
    transient,
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
    httpStatus: null,
    lastError: "observe timeout",
    transient: true,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function observeKey(identity: ObserveIdentity): string {
  return [
    identity.sessionId,
    identity.sandboxId,
    identity.generation,
    identity.wake ? "wake" : "peek",
  ].join(":");
}

function matchesSnapshot(
  identity: Pick<ObserveIdentity, "sandboxId" | "generation">,
  snapshot: DaytonaRuntimeSnapshot,
): boolean {
  return (
    identity.sandboxId === snapshot.sandboxId &&
    identity.generation === snapshot.generation
  );
}

type UrlProbe = {
  ready: boolean;
  http: number | null;
  lastError: string | null;
  transient: boolean;
};

async function probeUrl(url: string): Promise<UrlProbe> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(PREVIEW_HTTP_TIMEOUT_MS),
    });
    const http = res.status;
    await res.body?.cancel().catch(() => {});

    if (http >= 200 && http < 400) {
      return { ready: true, http, lastError: null, transient: false };
    }
    if (http >= 500) {
      return { ready: false, http, lastError: null, transient: false };
    }
    return {
      ready: false,
      http,
      lastError: `Preview returned HTTP ${http}`,
      transient: false,
    };
  } catch {
    // Timeout / connection refused while Next boots.
    return {
      ready: false,
      http: null,
      lastError: "preview probe failed",
      transient: true,
    };
  }
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
  lastError: string | null;
  transient: boolean;
}> {
  const sdk = sandbox.sdkSandbox;
  const port = getDaytonaDevPort();
  let url = cachedUrl ?? null;
  let firstProbe: UrlProbe | null = null;

  try {
    if (url) {
      firstProbe = await probeUrl(url);
      if (firstProbe.ready) {
        return {
          ...firstProbe,
          url,
          port,
          probeUrl: url,
        };
      }
    }

    // A cached URL may expire or change permissions. Refresh it once after any
    // failed cached probe instead of retrying the stale URL forever.
    if (!url || firstProbe) {
      await ensureSandboxPublic(sdk);
      const preview = await sdk.getPreviewLink(port);
      url = preview.url;
    }

    const probe = await probeUrl(url);
    return {
      ...probe,
      url,
      port,
      probeUrl: url,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ready: false,
      url,
      port,
      probeUrl: url,
      http: firstProbe?.http ?? null,
      lastError:
        firstProbe?.lastError ??
        `preview link refresh failed: ${detail.slice(0, 200)}`,
      transient: firstProbe?.transient ?? true,
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
      return {
        ...emptyObserved(
          isAsleep(peek.state) && !wake
            ? null
            : "sandbox reconnect failed but sandbox still exists",
          !isAsleep(peek.state) || wake,
        ),
        phase: "workspace-ready",
        sandboxId: snapshot.sandboxId,
        sandboxState: peek.state ?? null,
      };
    } catch {
      return emptyObserved();
    }
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
    lastError: preview.lastError,
    transient: preview.transient,
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
  identity: ObserveIdentity,
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
  void runPromise.then(
    (value) => {
      if (value.phase === "preview-ready") {
        lateReadyMailbox.set(sessionId, { ...identity, value });
        logDaytonaTiming(
          sessionId,
          "observe.lateMailbox",
          0,
          `stashed phase=${value.phase} generation=${identity.generation}`,
        );
      }
    },
    (error) => {
      const detail = error instanceof Error ? error.message : String(error);
      logDaytonaBootstrap(
        sessionId,
        "preview",
        `late observe failed: ${detail.slice(0, 160)}`,
      );
    },
  );

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
  const snapshot =
    options?.snapshot ??
    (await getRuntimeSnapshot(sessionId, null, { fresh: true }));

  if (!snapshot.sandboxId) {
    lateReadyMailbox.delete(sessionId);
    return emptyObserved();
  }

  const mailed = lateReadyMailbox.get(sessionId);
  if (mailed && matchesSnapshot(mailed, snapshot)) {
    lateReadyMailbox.delete(sessionId);
    logDaytonaTiming(sessionId, "observe.total", 0, "adopted-late-mailbox");
    return mailed.value;
  }
  if (mailed) {
    lateReadyMailbox.delete(sessionId);
    logDaytonaTiming(
      sessionId,
      "observe.lateMailbox",
      0,
      `dropped-stale mailboxGeneration=${mailed.generation} snapshotGeneration=${snapshot.generation}`,
    );
  }

  const identity: ObserveIdentity = {
    sessionId,
    sandboxId: snapshot.sandboxId,
    generation: snapshot.generation,
    wake,
  };
  const key = observeKey(identity);
  const existing = inFlightObserve.get(key);
  if (existing) {
    logDaytonaTiming(sessionId, "observe.coalesce", 0, "join-in-flight");
    try {
      return await awaitWithSoftDeadline(
        sessionId,
        existing.promise,
        snapshot,
        existing,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logDaytonaBootstrap(
        sessionId,
        "preview",
        `coalesced observe failed: ${detail.slice(0, 160)}`,
      );
      return emptyObserved(detail.slice(0, 500));
    }
  }

  const runPromise = runObserve(sessionId, snapshot, wake).finally(() => {
    if (inFlightObserve.get(key)?.promise === runPromise) {
      inFlightObserve.delete(key);
    }
  });
  inFlightObserve.set(key, { ...identity, promise: runPromise });

  try {
    return await awaitWithSoftDeadline(
      sessionId,
      runPromise,
      snapshot,
      identity,
    );
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
