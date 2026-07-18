import fs from "node:fs/promises";
import path from "node:path";

import { resolveSessionRoot } from "@/lib/sandbox/paths";

import type { SessionRuntimeProjection } from "./runtime-projection";

function getProjectionFilePath(
  sessionId: string,
  userId: string | null = null,
): string {
  return path.join(
    resolveSessionRoot(sessionId, userId),
    "runtime-projection.json",
  );
}

function isProjection(
  value: unknown,
): value is SessionRuntimeProjection {
  if (!value || typeof value !== "object") {
    return false;
  }
  const obj = value as SessionRuntimeProjection;
  return (
    typeof obj.sessionId === "string" &&
    typeof obj.version === "number" &&
    obj.run != null &&
    obj.preview != null &&
    obj.appTest != null
  );
}

export async function readRuntimeProjectionLocal(
  sessionId: string,
  userId: string | null = null,
): Promise<SessionRuntimeProjection | null> {
  try {
    const raw = await fs.readFile(
      getProjectionFilePath(sessionId, userId),
      "utf8",
    );
    const parsed = JSON.parse(raw) as unknown;
    if (!isProjection(parsed) || parsed.sessionId !== sessionId) {
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

/** Atomic overwrite — safe for high-frequency runtime updates. */
export async function writeRuntimeProjectionLocal(
  projection: SessionRuntimeProjection,
  userId: string | null = null,
): Promise<void> {
  const filePath = getProjectionFilePath(projection.sessionId, userId);
  const tmpPath = `${filePath}.tmp`;
  const sessionRoot = resolveSessionRoot(projection.sessionId, userId);

  await fs.mkdir(sessionRoot, { recursive: true });
  await fs.writeFile(
    tmpPath,
    `${JSON.stringify(projection, null, 2)}\n`,
    "utf8",
  );
  try {
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    // Concurrent test cleanup / clearRuntimeSnapshot may remove the session dir.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await fs.mkdir(sessionRoot, { recursive: true });
      await fs.writeFile(
        filePath,
        `${JSON.stringify(projection, null, 2)}\n`,
        "utf8",
      );
      return;
    }
    throw error;
  }
}
