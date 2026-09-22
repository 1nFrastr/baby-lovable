import type { ObservedRuntime } from "./daytona/runtime-observer";
import type { DevLogStreamEvent } from "./daytona/dev-log-stream";
import type { ProjectSandbox } from "./types";
import type { SandboxMode } from "./types";

export interface CreatedSandbox {
  sandboxId: string;
  project: ProjectSandbox;
  previewUrl: string | null;
  previewPort: number;
}

export interface StartedDev {
  sessionName: string | null;
  cmdId: string | null;
  port: number;
  previewUrl: string | null;
}

export interface StreamDevLogsInput {
  project: ProjectSandbox;
  sessionId: string;
  sessionName: string | null;
  cmdId: string;
  generation: number;
  onEvent: (event: DevLogStreamEvent) => void;
  signal: AbortSignal;
}

/**
 * Provider-specific VM / preview primitives.
 * The shared reconciler owns desired/observed, leases, and Freestyle hydrate.
 */
export interface SandboxVmDriver {
  readonly id: SandboxMode;

  getDevPort(): number;
  defaultDevSessionName(sessionId: string): string | null;

  create(sessionId: string): Promise<CreatedSandbox>;
  reconnect(
    sessionId: string,
    sandboxId: string,
    wake: boolean,
  ): Promise<ProjectSandbox | null>;
  exists(sandboxId: string): Promise<boolean>;
  deleteById(sessionId: string, sandboxId: string): Promise<void>;
  deleteProject(project: ProjectSandbox): Promise<void>;

  startDev(project: ProjectSandbox, sessionId: string): Promise<StartedDev>;
  stopDev(project: ProjectSandbox | null, sessionId: string): Promise<void>;
  getPreviewUrl(project: ProjectSandbox, port: number): Promise<string | null>;

  observe(
    sessionId: string,
    options?: { wake?: boolean; snapshot?: import("./daytona/runtime-state").DaytonaRuntimeSnapshot },
  ): Promise<ObservedRuntime>;

  resolveDevCmdId(
    project: ProjectSandbox,
    sessionName: string | null,
    persistedCmdId: string | null,
  ): Promise<string | null>;
  streamDevLogs(input: StreamDevLogsInput): Promise<void>;

  extendSessionIfNeeded(project: ProjectSandbox): Promise<void>;
  /** After a stopped VM resumes: Vercel restarts `pnpm dev`; Daytona is a no-op. */
  onResume(project: ProjectSandbox, sessionId: string): Promise<void>;
  formatStartError(error: unknown): string;
  clearAttachCache(sessionId: string): void;
}
