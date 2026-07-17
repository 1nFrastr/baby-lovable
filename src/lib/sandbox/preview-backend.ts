import { getSession } from "@/lib/session/store";
import {
  deleteDaytonaSandbox,
  getDaytonaSandboxStatus,
} from "./daytona/sandbox";
import {
  checkLocalAppServer,
  getLocalAppServerStatus,
  getLocalBuildError,
  hasLocalNodeModules,
  restartLocalAppServer,
  startLocalAppServer,
  startLocalPreview,
  stopLocalAppServer,
} from "./local/app-server";
import {
  checkDaytonaAppServer,
  getDaytonaAppServerStatus,
  getDaytonaBuildError,
  hasDaytonaNodeModules,
  restartDaytonaAppServer,
  startDaytonaAppServer,
  startDaytonaPreview,
  stopDaytonaAppServer,
} from "./daytona/app-server";
import { getLocalSandboxStatus } from "./local/sandbox";
import type {
  AppServerCheck,
  AppServerStatus,
  SandboxStatus,
} from "./preview-types";
import type { SandboxMode } from "./types";

/** One backend per sandbox mode — no mode ifs at call sites. */
export interface PreviewBackend {
  getSandboxStatus(sessionId: string): Promise<SandboxStatus>;
  getAppServerStatus(sessionId: string): Promise<AppServerStatus>;
  checkAppServer(sessionId: string): Promise<AppServerCheck>;
  getBuildError(sessionId: string): Promise<string | null>;
  startPreview(sessionId: string): void;
  startAppServer(sessionId: string): Promise<AppServerStatus>;
  restartAppServer(sessionId: string): Promise<AppServerStatus>;
  stopAppServer(sessionId: string): Promise<void>;
  deleteSandbox(sessionId: string): Promise<void>;
  hasNodeModules(sessionId: string): Promise<boolean>;
}

const localBackend: PreviewBackend = {
  getSandboxStatus: getLocalSandboxStatus,
  getAppServerStatus: getLocalAppServerStatus,
  checkAppServer: checkLocalAppServer,
  getBuildError: async (sessionId) => getLocalBuildError(sessionId),
  startPreview: startLocalPreview,
  startAppServer: startLocalAppServer,
  restartAppServer: restartLocalAppServer,
  stopAppServer: stopLocalAppServer,
  deleteSandbox: stopLocalAppServer,
  hasNodeModules: hasLocalNodeModules,
};

const daytonaBackend: PreviewBackend = {
  getSandboxStatus: getDaytonaSandboxStatus,
  getAppServerStatus: getDaytonaAppServerStatus,
  checkAppServer: checkDaytonaAppServer,
  getBuildError: getDaytonaBuildError,
  startPreview: startDaytonaPreview,
  startAppServer: startDaytonaAppServer,
  restartAppServer: restartDaytonaAppServer,
  stopAppServer: stopDaytonaAppServer,
  async deleteSandbox(sessionId) {
    await stopDaytonaAppServer(sessionId);
    await deleteDaytonaSandbox(sessionId);
  },
  hasNodeModules: hasDaytonaNodeModules,
};

export function createPreviewBackend(mode: SandboxMode): PreviewBackend {
  return mode === "daytona" ? daytonaBackend : localBackend;
}

export async function getPreviewBackend(
  sessionId: string,
): Promise<PreviewBackend> {
  const session = await getSession(sessionId);
  return createPreviewBackend(session?.sandboxMode ?? "local");
}
