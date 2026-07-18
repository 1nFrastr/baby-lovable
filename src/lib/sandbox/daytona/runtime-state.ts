/**
 * Daytona runtime snapshot — single source of truth for desired / observed state.
 * Public preview-types are derived from this; do not export these via preview-types.
 */

import type {
  AllStatus,
  AppServerStatus,
  PreviewUrlStatus,
  SandboxStatus,
} from "../preview-types";
import { getDaytonaDevPort } from "./config";

export type DaytonaDesiredState =
  | "deleted"
  | "stopped"
  | "sandbox-ready"
  | "preview-ready";

export type DaytonaObservedPhase =
  | "missing"
  | "creating-sandbox"
  | "bootstrapping-workspace"
  | "workspace-ready"
  | "installing-deps"
  | "starting-devserver"
  | "preview-ready"
  | "stopping"
  | "deleting"
  | "error";

export interface DaytonaRuntimeSnapshot {
  sessionId: string;
  revision: number;
  generation: number;

  desired: DaytonaDesiredState;
  observed: DaytonaObservedPhase;

  sandboxId: string | null;
  devSessionName: string | null;

  previewUrl: string | null;
  previewPort: number | null;
  previewExpiresAtMs: number | null;

  lastError: string | null;
  lastObservedAt: string | null;

  leaseOwner: string | null;
  leaseExpiresAt: string | null;

  /** Transient: clear .next before next preview start (restart path). */
  clearNextCache?: boolean;
}

export type DaytonaRuntimePatch = Partial<
  Omit<DaytonaRuntimeSnapshot, "sessionId" | "revision">
> & {
  /** Expected revision for CAS; omit only when creating. */
  expectedRevision?: number;
};

export function emptyRuntimeSnapshot(
  sessionId: string,
): DaytonaRuntimeSnapshot {
  return {
    sessionId,
    revision: 0,
    generation: 0,
    desired: "stopped",
    observed: "missing",
    sandboxId: null,
    devSessionName: null,
    previewUrl: null,
    previewPort: null,
    previewExpiresAtMs: null,
    lastError: null,
    lastObservedAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    clearNextCache: false,
  };
}

export function deriveSandboxStatus(
  snapshot: DaytonaRuntimeSnapshot,
): SandboxStatus {
  switch (snapshot.observed) {
    case "missing":
    case "deleting":
      return snapshot.sandboxId ? "stopped" : "missing";
    case "creating-sandbox":
      return "starting";
    case "error":
      return snapshot.sandboxId ? "error" : "missing";
    case "stopping":
      return "stopped";
    default:
      return snapshot.sandboxId ? "running" : "missing";
  }
}

export function deriveAppServerStatus(
  snapshot: DaytonaRuntimeSnapshot,
): AppServerStatus {
  const port = snapshot.previewPort ?? getDaytonaDevPort();

  if (snapshot.observed === "error" && snapshot.lastError) {
    return { status: "error", error: snapshot.lastError };
  }

  const starting = (): AppServerStatus =>
    snapshot.previewUrl
      ? { status: "starting", port, url: snapshot.previewUrl }
      : { status: "starting", port };

  switch (snapshot.observed) {
    case "installing-deps":
      return { status: "installing" };
    case "starting-devserver":
      return starting();
    case "preview-ready":
      if (snapshot.previewUrl && snapshot.previewPort != null) {
        return {
          status: "ready",
          url: snapshot.previewUrl,
          port: snapshot.previewPort,
        };
      }
      return starting();
    case "bootstrapping-workspace":
    case "creating-sandbox":
      if (snapshot.desired === "preview-ready") {
        return starting();
      }
      return { status: "stopped" };
    case "workspace-ready":
      if (snapshot.desired === "preview-ready") {
        return starting();
      }
      return { status: "stopped" };
    case "missing":
    case "stopping":
    case "deleting":
    case "error":
    default:
      return { status: "stopped" };
  }
}

export function derivePreviewUrlStatus(
  snapshot: DaytonaRuntimeSnapshot,
): PreviewUrlStatus {
  const app = deriveAppServerStatus(snapshot);
  if (app.status === "ready") {
    return { status: "ready", url: app.url };
  }
  // Public preview URL stays valid across Next restarts (502 while down).
  if (app.status === "starting" && app.url) {
    return { status: "ready", url: app.url };
  }
  return { status: "none" };
}

export function deriveAllStatus(snapshot: DaytonaRuntimeSnapshot): AllStatus {
  return {
    sandbox: deriveSandboxStatus(snapshot),
    appServer: deriveAppServerStatus(snapshot),
    previewUrl: derivePreviewUrlStatus(snapshot),
  };
}

/** Cached public preview URL is present — safe to show iframe without re-probe. */
export function hasFreshPreviewEmbed(
  snapshot: DaytonaRuntimeSnapshot,
): boolean {
  if (snapshot.observed !== "preview-ready") {
    return false;
  }
  return Boolean(snapshot.previewUrl) && snapshot.previewPort != null;
}

/** True when observed reality satisfies the desired target. */
export function isDesiredSatisfied(snapshot: DaytonaRuntimeSnapshot): boolean {
  // Restart must force another start cycle even if preview already looks ready.
  if (snapshot.clearNextCache) {
    return false;
  }

  switch (snapshot.desired) {
    case "deleted":
      return snapshot.observed === "missing" && !snapshot.sandboxId;
    case "stopped":
      // Must not treat "missing" as done while create/bootstrap/start is in-flight,
      // or a UI stop waiter can return before the writer isolate notices.
      if (
        snapshot.previewUrl ||
        snapshot.observed === "preview-ready" ||
        snapshot.observed === "starting-devserver" ||
        snapshot.observed === "installing-deps" ||
        snapshot.observed === "creating-sandbox" ||
        snapshot.observed === "bootstrapping-workspace" ||
        snapshot.observed === "deleting"
      ) {
        return false;
      }
      return (
        snapshot.observed === "workspace-ready" ||
        snapshot.observed === "missing" ||
        snapshot.observed === "stopping"
      );
    case "sandbox-ready":
      return (
        snapshot.observed === "workspace-ready" ||
        snapshot.observed === "preview-ready" ||
        snapshot.observed === "installing-deps" ||
        snapshot.observed === "starting-devserver"
      ) && Boolean(snapshot.sandboxId);
    case "preview-ready":
      return (
        snapshot.observed === "preview-ready" &&
        Boolean(snapshot.previewUrl) &&
        snapshot.previewPort != null
      );
    default:
      return false;
  }
}
