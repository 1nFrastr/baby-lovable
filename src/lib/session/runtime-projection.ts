import type { AppTestLatestStatus, AppTestRunStatus } from "@/lib/browser-run/types";
import type { SourceControlProjection } from "@/lib/git/types";
import type { AllStatus, SandboxStatus } from "@/lib/sandbox/preview-types";

import type { SessionRunStatus } from "./types";

/** UI-facing run status (simplified from SessionRunStatus). */
export type RuntimeRunStatus =
  | "idle"
  | "running"
  | "done"
  | "error"
  | "cancelled";

/** True when the projection left an in-flight agent turn. */
export function isFinishedRuntimeRunStatus(
  status: RuntimeRunStatus,
): boolean {
  return status !== "running";
}

export type RuntimeAppServerStatus =
  | "stopped"
  | "installing"
  | "starting"
  | "ready"
  | "error"
  | "needs_install";

export interface SessionRuntimeProjection {
  sessionId: string;
  /** Monotonic; clients only accept version > local. */
  version: number;
  run: {
    status: RuntimeRunStatus;
    runId?: string;
    updatedAt: string;
  };
  preview: {
    generation: number;
    sandbox: SandboxStatus;
    appServerStatus: RuntimeAppServerStatus;
    url?: string;
    error?: string;
    updatedAt: string;
  };
  appTest: {
    runId?: string;
    status: AppTestRunStatus;
    liveViewUrl?: string;
    summary?: string;
    ok?: boolean;
    updatedAt: string;
  };
  sourceControl: SourceControlProjection;
}

export type RuntimeProjectionPatch = {
  run?: Partial<SessionRuntimeProjection["run"]>;
  preview?: Partial<SessionRuntimeProjection["preview"]>;
  appTest?: Partial<SessionRuntimeProjection["appTest"]>;
  sourceControl?: Partial<SourceControlProjection>;
};

export function mapSessionRunStatus(
  status: SessionRunStatus,
): RuntimeRunStatus {
  switch (status) {
    case "pending":
    case "running":
      return "running";
    case "completed":
      return "done";
    case "failed":
      return "error";
    case "cancelled":
      return "cancelled";
    case "idle":
    default:
      return "idle";
  }
}

/** Map projection run status back to SessionRunStatus for legacy UI helpers. */
export function toSessionRunStatus(
  status: RuntimeRunStatus,
): SessionRunStatus {
  switch (status) {
    case "running":
      return "running";
    case "done":
      return "completed";
    case "error":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "idle":
    default:
      return "idle";
  }
}

/**
 * Pick the live runStatus for composer lock / chat UI.
 *
 * Runtime Realtime is the fast path, but `publishRuntimeUpdate` is best-effort.
 * When the session row and projection disagree, prefer the newer `updatedAt`
 * so a failed publish cannot leave the composer locked on a stale `running`.
 */
export function resolveLiveRunStatus(
  projectionRun:
    | { status: RuntimeRunStatus; updatedAt: string }
    | null
    | undefined,
  session:
    | { runStatus: SessionRunStatus; updatedAt: string }
    | null
    | undefined,
): SessionRunStatus {
  return resolveLiveRunState(projectionRun, session).runStatus;
}

export function resolveLiveRunState(
  projectionRun:
    | { status: RuntimeRunStatus; updatedAt: string }
    | null
    | undefined,
  session:
    | { runStatus: SessionRunStatus; updatedAt: string }
    | null
    | undefined,
): { runStatus: SessionRunStatus; updatedAt: string } {
  if (!projectionRun) {
    return {
      runStatus: session?.runStatus ?? "idle",
      updatedAt: session?.updatedAt ?? "",
    };
  }
  if (!session) {
    return {
      runStatus: toSessionRunStatus(projectionRun.status),
      updatedAt: projectionRun.updatedAt,
    };
  }

  const fromProjection = toSessionRunStatus(projectionRun.status);
  if (fromProjection === session.runStatus) {
    // Same status — prefer the newer stamp so awaitingRunStart can detect
    // a fresh terminal after send.
    const updatedAt =
      session.updatedAt >= projectionRun.updatedAt
        ? session.updatedAt
        : projectionRun.updatedAt;
    return { runStatus: fromProjection, updatedAt };
  }

  if (session.updatedAt >= projectionRun.updatedAt) {
    return {
      runStatus: session.runStatus,
      updatedAt: session.updatedAt,
    };
  }
  return {
    runStatus: fromProjection,
    updatedAt: projectionRun.updatedAt,
  };
}

export function previewFromAllStatus(
  all: AllStatus,
  generation: number,
  updatedAt: string = new Date().toISOString(),
): SessionRuntimeProjection["preview"] {
  const app = all.appServer;
  return {
    generation,
    sandbox: all.sandbox,
    appServerStatus: app.status,
    url:
      app.status === "ready" ||
      app.status === "starting" ||
      app.status === "installing"
        ? app.url
        : undefined,
    error: app.status === "error" ? app.error : undefined,
    updatedAt,
  };
}

export function appTestFromLatest(
  latest: AppTestLatestStatus,
  updatedAt: string = new Date().toISOString(),
): SessionRuntimeProjection["appTest"] {
  return {
    runId: latest.runId,
    status: latest.status,
    liveViewUrl: latest.liveViewUrl,
    summary: latest.summary,
    ok: latest.ok,
    updatedAt: latest.finishedAt ?? latest.startedAt ?? updatedAt,
  };
}

export function emptyRuntimeProjection(
  sessionId: string,
  updatedAt: string = new Date().toISOString(),
): SessionRuntimeProjection {
  return {
    sessionId,
    version: 0,
    run: { status: "idle", updatedAt },
    preview: {
      generation: 0,
      sandbox: "missing",
      appServerStatus: "stopped",
      updatedAt,
    },
    appTest: { status: "idle", updatedAt },
    sourceControl: { status: "idle", updatedAt },
  };
}

export function mergeRuntimeProjection(
  current: SessionRuntimeProjection,
  patch: RuntimeProjectionPatch,
): SessionRuntimeProjection {
  const sourceControl =
    current.sourceControl ??
    ({ status: "idle", updatedAt: new Date().toISOString() } as SourceControlProjection);

  return {
    sessionId: current.sessionId,
    version: current.version,
    run: patch.run ? { ...current.run, ...patch.run } : current.run,
    preview: patch.preview
      ? { ...current.preview, ...patch.preview }
      : current.preview,
    appTest: patch.appTest
      ? { ...current.appTest, ...patch.appTest }
      : current.appTest,
    sourceControl: patch.sourceControl
      ? { ...sourceControl, ...patch.sourceControl }
      : sourceControl,
  };
}

/** UI-visible fields that gate version bumps (ignore updatedAt / version). */
export function runtimeUiSignature(
  projection: SessionRuntimeProjection,
): string {
  const sourceControl = projection.sourceControl ?? { status: "idle" };
  return JSON.stringify({
    run: {
      status: projection.run.status,
      runId: projection.run.runId ?? null,
    },
    preview: {
      generation: projection.preview.generation,
      sandbox: projection.preview.sandbox,
      appServerStatus: projection.preview.appServerStatus,
      url: projection.preview.url ?? null,
      error: projection.preview.error ?? null,
    },
    appTest: {
      runId: projection.appTest.runId ?? null,
      status: projection.appTest.status,
      liveViewUrl: projection.appTest.liveViewUrl ?? null,
      summary: projection.appTest.summary ?? null,
      ok: projection.appTest.ok ?? null,
    },
    sourceControl: {
      status: sourceControl.status,
      shortSha: sourceControl.shortSha ?? null,
      error: sourceControl.error ?? null,
      githubRepoName: sourceControl.githubRepoName ?? null,
    },
  });
}

export function shouldBumpRuntimeVersion(
  before: SessionRuntimeProjection,
  after: SessionRuntimeProjection,
): boolean {
  return runtimeUiSignature(before) !== runtimeUiSignature(after);
}
