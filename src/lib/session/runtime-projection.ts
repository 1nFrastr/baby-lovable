import type { AppTestLatestStatus, AppTestRunStatus } from "@/lib/browser-run/types";
import type { AllStatus, SandboxStatus } from "@/lib/sandbox/preview-types";

import type { SessionRunStatus } from "./types";

/** UI-facing run status (simplified from SessionRunStatus). */
export type RuntimeRunStatus = "idle" | "running" | "done" | "error";

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
}

export type RuntimeProjectionPatch = {
  run?: Partial<SessionRuntimeProjection["run"]>;
  preview?: Partial<SessionRuntimeProjection["preview"]>;
  appTest?: Partial<SessionRuntimeProjection["appTest"]>;
};

export type RuntimeTransport = "sse" | "realtime";

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
    case "idle":
    default:
      return "idle";
  }
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
      app.status === "ready" || app.status === "starting"
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
  };
}

export function mergeRuntimeProjection(
  current: SessionRuntimeProjection,
  patch: RuntimeProjectionPatch,
): SessionRuntimeProjection {
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
  };
}

/** UI-visible fields that gate version bumps (ignore updatedAt / version). */
export function runtimeUiSignature(
  projection: SessionRuntimeProjection,
): string {
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
  });
}

export function shouldBumpRuntimeVersion(
  before: SessionRuntimeProjection,
  after: SessionRuntimeProjection,
): boolean {
  return runtimeUiSignature(before) !== runtimeUiSignature(after);
}
