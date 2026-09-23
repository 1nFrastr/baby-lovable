import { isDaytonaFreePlan } from "@/lib/features/daytona-free-plan";
import type { SourceControlProjection } from "@/lib/git/types";
import type { AllStatus, SandboxStatus } from "@/lib/sandbox/preview-types";
import type { SandboxMode } from "@/lib/sandbox/types";

export type RuntimeAppServerStatus =
  | "stopped"
  | "installing"
  | "starting"
  | "ready"
  | "error"
  | "needs_install";

export interface SessionRuntimeCapabilities {
  /** Ephemeral Daytona without Freestyle SoT / GitHub Sync / History / Export. */
  daytonaFreePlan: boolean;
}

export interface SessionRuntimeProjection {
  sessionId: string;
  /** Monotonic; clients only accept version > local. */
  version: number;
  preview: {
    generation: number;
    sandbox: SandboxStatus;
    appServerStatus: RuntimeAppServerStatus;
    url?: string;
    error?: string;
    updatedAt: string;
  };
  sourceControl: SourceControlProjection;
  /** Live product gates; overlaid from env on every read. */
  capabilities: SessionRuntimeCapabilities;
}

export type RuntimeProjectionPatch = {
  preview?: Partial<SessionRuntimeProjection["preview"]>;
  sourceControl?: Partial<SourceControlProjection>;
};

export function currentRuntimeCapabilities(
  mode?: SandboxMode,
): SessionRuntimeCapabilities {
  return {
    daytonaFreePlan: isDaytonaFreePlan(mode),
  };
}

/** Overlay live env capabilities onto a stored projection. */
export function withLiveCapabilities(
  projection: SessionRuntimeProjection,
  mode?: SandboxMode,
): SessionRuntimeProjection {
  return {
    ...projection,
    capabilities: currentRuntimeCapabilities(mode),
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

export function emptyRuntimeProjection(
  sessionId: string,
  updatedAt: string = new Date().toISOString(),
  mode?: SandboxMode,
): SessionRuntimeProjection {
  return {
    sessionId,
    version: 0,
    preview: {
      generation: 0,
      sandbox: "missing",
      appServerStatus: "stopped",
      updatedAt,
    },
    sourceControl: { status: "idle", updatedAt },
    capabilities: currentRuntimeCapabilities(mode),
  };
}

export function mergeRuntimeProjection(
  current: SessionRuntimeProjection,
  patch: RuntimeProjectionPatch,
  mode?: SandboxMode,
): SessionRuntimeProjection {
  const sourceControl =
    current.sourceControl ??
    ({ status: "idle", updatedAt: new Date().toISOString() } as SourceControlProjection);

  return {
    sessionId: current.sessionId,
    version: current.version,
    preview: patch.preview
      ? { ...current.preview, ...patch.preview }
      : current.preview,
    sourceControl: patch.sourceControl
      ? { ...sourceControl, ...patch.sourceControl }
      : sourceControl,
    capabilities: currentRuntimeCapabilities(mode),
  };
}

/** UI-visible fields that gate version bumps (ignore updatedAt / version). */
export function runtimeUiSignature(
  projection: SessionRuntimeProjection,
): string {
  const sourceControl = projection.sourceControl ?? { status: "idle" };
  return JSON.stringify({
    preview: {
      generation: projection.preview.generation,
      sandbox: projection.preview.sandbox,
      appServerStatus: projection.preview.appServerStatus,
      url: projection.preview.url ?? null,
      error: projection.preview.error ?? null,
    },
    sourceControl: {
      status: sourceControl.status,
      shortSha: sourceControl.shortSha ?? null,
      error: sourceControl.error ?? null,
      githubRepoName: sourceControl.githubRepoName ?? null,
    },
    capabilities: {
      daytonaFreePlan: projection.capabilities?.daytonaFreePlan ?? false,
    },
  });
}

export function shouldBumpRuntimeVersion(
  before: SessionRuntimeProjection,
  after: SessionRuntimeProjection,
): boolean {
  return runtimeUiSignature(before) !== runtimeUiSignature(after);
}
