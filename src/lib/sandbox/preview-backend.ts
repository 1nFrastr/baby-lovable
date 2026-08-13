import {
  deleteDaytonaSandbox,
  getDaytonaSandboxStatus,
} from "./daytona/sandbox";
import {
  checkDaytonaAppServer,
  getDaytonaAppServerStatus,
  getDaytonaBuildError,
  restartDaytonaAppServer,
  startDaytonaAppServer,
  startDaytonaPreview,
  stopDaytonaAppServer,
} from "./daytona/app-server";
import type {
  AppServerCheck,
  AppServerStatus,
  SandboxStatus,
} from "./preview-types";

/** Daytona is the sole preview backend in every environment. */
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
}

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
};

export function createPreviewBackend(): PreviewBackend {
  return daytonaBackend;
}

export async function getPreviewBackend(
  sessionId: string,
): Promise<PreviewBackend> {
  void sessionId;
  return daytonaBackend;
}
