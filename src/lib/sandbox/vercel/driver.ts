import { formatVercelStartError, startVercelDevSession, stopVercelDevSession } from "./app-server-boot";
import { resolveVercelDevCmdId, streamVercelDevLogs } from "./dev-log-stream";
import { clearVercelAttachCache } from "./fs-attach-cache";
import { observeVercelRuntime } from "./runtime-observer";
import { asVercelProject } from "./provider";
import {
  createVercelSandbox,
  deleteVercelSandboxById,
  reconnectVercelSandbox,
  vercelSandboxExists,
  wrapVercelSandbox,
} from "./vm";
import { getVercelDevPort, getVercelIdleMs } from "./config";
import type { ProjectSandbox } from "../types";
import type {
  CreatedSandbox,
  SandboxVmDriver,
  StartedDev,
  StreamDevLogsInput,
} from "../vm-driver";

export const vercelDriver: SandboxVmDriver = {
  id: "vercel",

  getDevPort() {
    return getVercelDevPort();
  },

  defaultDevSessionName() {
    return "preview";
  },

  async create(sessionId): Promise<CreatedSandbox> {
    const sdk = await createVercelSandbox(sessionId);
    const project = wrapVercelSandbox(sessionId, sdk);
    const previewPort = getVercelDevPort();
    let previewUrl: string | null = null;
    try {
      previewUrl = sdk.domain(previewPort);
    } catch {
      previewUrl = null;
    }
    return { sandboxId: sdk.name, project, previewUrl, previewPort };
  },

  async reconnect(sessionId, sandboxId, wake) {
    const sdk = await reconnectVercelSandbox(sessionId, sandboxId, wake);
    if (!sdk) {
      return null;
    }
    return wrapVercelSandbox(sessionId, sdk);
  },

  exists(sandboxId) {
    return vercelSandboxExists(sandboxId);
  },

  deleteById(sessionId, sandboxId) {
    return deleteVercelSandboxById(sessionId, sandboxId);
  },

  async deleteProject(project) {
    try {
      await asVercelProject(project).sdkSandbox.delete();
    } catch {
      // already gone
    }
  },

  async startDev(project, sessionId): Promise<StartedDev> {
    const started = await startVercelDevSession(project, sessionId);
    let previewUrl: string | null = null;
    try {
      previewUrl = asVercelProject(project).sdkSandbox.domain(started.port);
    } catch {
      previewUrl = null;
    }
    return { ...started, previewUrl };
  },

  stopDev(project, sessionId) {
    return stopVercelDevSession(project, sessionId);
  },

  async getPreviewUrl(project, port) {
    try {
      return asVercelProject(project).sdkSandbox.domain(port);
    } catch {
      return null;
    }
  },

  observe(sessionId, options) {
    return observeVercelRuntime(sessionId, options);
  },

  resolveDevCmdId(project, _sessionName, persistedCmdId) {
    return resolveVercelDevCmdId(project, persistedCmdId);
  },

  async streamDevLogs(input: StreamDevLogsInput) {
    await streamVercelDevLogs(
      input.project,
      input.cmdId,
      input.onEvent,
      input.signal,
    );
  },

  async extendSessionIfNeeded(project: ProjectSandbox) {
    try {
      await asVercelProject(project).sdkSandbox.extendTimeout(getVercelIdleMs());
    } catch {
      // at plan max or already extended
    }
  },

  async onResume(project, sessionId) {
    await stopVercelDevSession(project, sessionId);
    await startVercelDevSession(project, sessionId);
  },

  formatStartError: formatVercelStartError,

  clearAttachCache(sessionId) {
    clearVercelAttachCache(sessionId);
  },
};

export function getVercelDriver(): SandboxVmDriver {
  return vercelDriver;
}
