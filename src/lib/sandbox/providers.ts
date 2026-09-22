import { getSessionOwner } from "@/lib/session/store";

import type { SandboxMode } from "./types";
import type { SandboxVmDriver } from "./vm-driver";
import { getDaytonaDriver } from "./daytona/driver";
import { getVercelDriver } from "./vercel/driver";

export type { SandboxVmDriver, CreatedSandbox, StartedDev, StreamDevLogsInput } from "./vm-driver";

const driverCache = new Map<string, SandboxVmDriver>();

export function getSandboxDriver(mode: SandboxMode): SandboxVmDriver {
  if (mode === "vercel") {
    return getVercelDriver();
  }
  return getDaytonaDriver();
}

export async function getSandboxDriverForSession(
  sessionId: string,
): Promise<SandboxVmDriver> {
  const cached = driverCache.get(sessionId);
  if (cached) {
    return cached;
  }
  const owner = await getSessionOwner(sessionId);
  const mode = owner?.sandboxMode ?? "daytona";
  const driver = getSandboxDriver(mode);
  driverCache.set(sessionId, driver);
  return driver;
}

export function clearSandboxDriverCache(sessionId?: string): void {
  if (sessionId) {
    driverCache.delete(sessionId);
    return;
  }
  driverCache.clear();
}
