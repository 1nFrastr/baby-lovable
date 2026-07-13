import fs from "node:fs/promises";
import path from "node:path";

import type { AppTestLatestStatus } from "@/lib/browser-run/types";
import { resolveSessionRoot } from "@/lib/sandbox/paths";

function getStatusFilePath(
  sessionId: string,
  userId: string | null = null,
): string {
  return path.join(resolveSessionRoot(sessionId, userId), "app-test-status.json");
}

export async function readAppTestStatusLocal(
  sessionId: string,
  userId: string | null = null,
): Promise<AppTestLatestStatus | null> {
  try {
    const raw = await fs.readFile(getStatusFilePath(sessionId, userId), "utf8");
    const parsed = JSON.parse(raw) as AppTestLatestStatus;
    if (!parsed || typeof parsed !== "object" || !parsed.status) {
      return null;
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** Atomic overwrite — safe for high-frequency Live View status updates. */
export async function writeAppTestStatusLocal(
  sessionId: string,
  status: AppTestLatestStatus,
  userId: string | null = null,
): Promise<void> {
  const filePath = getStatusFilePath(sessionId, userId);
  const tmpPath = `${filePath}.tmp`;
  const sessionRoot = resolveSessionRoot(sessionId, userId);

  await fs.mkdir(sessionRoot, { recursive: true });
  await fs.writeFile(tmpPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}
