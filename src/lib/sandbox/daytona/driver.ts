import type { Sandbox } from "@daytona/sdk";

import { DEV_SESSION, formatStartError, startDevSession, stopDevSession } from "./app-server-boot";
import { streamDevCommandLogs } from "./dev-log-stream";
import { clearDaytonaAttachCache } from "./fs-attach-cache";
import type { DaytonaProjectSandbox } from "./provider";
import { observeRuntime } from "./runtime-observer";
import { resolveDevCmdId } from "./resolve-dev-cmd-id";
import {
  createSandbox,
  deleteSandboxById,
  ensureSandboxPublic,
  reconnectSandbox,
  sandboxRecordExists,
  wrapSandbox,
} from "./vm";
import { getDaytonaDevPort } from "./config";
import type { ProjectSandbox } from "../types";
import type {
  CreatedSandbox,
  SandboxVmDriver,
  StartedDev,
  StreamDevLogsInput,
} from "../vm-driver";

function asDaytona(project: ProjectSandbox): DaytonaProjectSandbox {
  if ("sdkSandbox" in project && (project as DaytonaProjectSandbox).sdkSandbox) {
    return project as DaytonaProjectSandbox;
  }
  throw new Error("Expected a Daytona project sandbox");
}

function sdkOf(project: ProjectSandbox): Sandbox {
  return asDaytona(project).sdkSandbox;
}

export const daytonaDriver: SandboxVmDriver = {
  id: "daytona",

  getDevPort() {
    return getDaytonaDevPort();
  },

  defaultDevSessionName(sessionId) {
    return DEV_SESSION(sessionId);
  },

  async create(sessionId): Promise<CreatedSandbox> {
    const sdk = await createSandbox(sessionId);
    const project = wrapSandbox(sessionId, sdk);
    const previewPort = getDaytonaDevPort();
    let previewUrl: string | null = null;
    try {
      await ensureSandboxPublic(sdk);
      const link = await sdk.getPreviewLink(previewPort);
      previewUrl = link.url;
    } catch {
      // iframe can wait until startDev
    }
    return { sandboxId: sdk.id, project, previewUrl, previewPort };
  },

  async reconnect(sessionId, sandboxId, wake) {
    const sdk = await reconnectSandbox(sessionId, sandboxId, wake);
    if (!sdk) {
      return null;
    }
    return wrapSandbox(sessionId, sdk);
  },

  exists(sandboxId) {
    return sandboxRecordExists(sandboxId);
  },

  deleteById(sessionId, sandboxId) {
    return deleteSandboxById(sessionId, sandboxId);
  },

  async deleteProject(project) {
    try {
      await sdkOf(project).delete(60);
    } catch {
      // already gone
    }
  },

  async startDev(project, sessionId): Promise<StartedDev> {
    const daytona = asDaytona(project);
    const started = await startDevSession(daytona, sessionId);
    let previewUrl: string | null = null;
    try {
      await ensureSandboxPublic(daytona.sdkSandbox);
      const link = await daytona.sdkSandbox.getPreviewLink(started.port);
      previewUrl = link.url;
    } catch {
      // keep prior url
    }
    return {
      sessionName: started.sessionName,
      cmdId: started.cmdId,
      port: started.port,
      previewUrl,
    };
  },

  stopDev(project, sessionId) {
    return stopDevSession(project ? asDaytona(project) : null, sessionId);
  },

  async getPreviewUrl(project, port) {
    try {
      const sdk = sdkOf(project);
      await ensureSandboxPublic(sdk);
      const link = await sdk.getPreviewLink(port);
      return link.url;
    } catch {
      return null;
    }
  },

  observe(sessionId, options) {
    return observeRuntime(sessionId, options);
  },

  resolveDevCmdId(project, sessionName, persistedCmdId) {
    if (!sessionName) {
      return Promise.resolve(null);
    }
    return resolveDevCmdId(sdkOf(project), sessionName, persistedCmdId);
  },

  async streamDevLogs(input: StreamDevLogsInput) {
    const { project, sessionName, cmdId, onEvent, signal } = input;
    if (!sessionName) {
      onEvent({ type: "waiting", reason: "Dev session not started yet" });
      return;
    }
    await streamDevCommandLogs(sdkOf(project), sessionName, cmdId, onEvent, signal);
  },

  async extendSessionIfNeeded() {
    // Daytona idle is autoStopInterval on the VM.
  },

  async onResume() {
    // Daytona session commands survive wake; reconciler restarts if HTTP is down.
  },

  formatStartError,

  clearAttachCache(sessionId) {
    clearDaytonaAttachCache(sessionId);
  },
};

export function getDaytonaDriver(): SandboxVmDriver {
  return daytonaDriver;
}
