import fs from "node:fs/promises";
import path from "node:path";

import { resolveSessionRoot } from "@/lib/sandbox/paths";

import {
  emptyRuntimeSnapshot,
  type DaytonaRuntimeSnapshot,
} from "./runtime-state";

function getRuntimeFilePath(
  sessionId: string,
  userId: string | null = null,
): string {
  return path.join(
    resolveSessionRoot(sessionId, userId),
    "daytona-runtime.json",
  );
}

function isValidSnapshot(value: unknown): value is DaytonaRuntimeSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const s = value as DaytonaRuntimeSnapshot;
  return (
    typeof s.sessionId === "string" &&
    typeof s.revision === "number" &&
    typeof s.generation === "number" &&
    typeof s.desired === "string" &&
    typeof s.observed === "string"
  );
}

export async function readRuntimeLocal(
  sessionId: string,
  userId: string | null = null,
): Promise<DaytonaRuntimeSnapshot | null> {
  try {
    const raw = await fs.readFile(getRuntimeFilePath(sessionId, userId), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidSnapshot(parsed)) {
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

export async function writeRuntimeLocal(
  snapshot: DaytonaRuntimeSnapshot,
  userId: string | null = null,
  options?: { createOnly?: boolean },
): Promise<void> {
  const filePath = getRuntimeFilePath(snapshot.sessionId, userId);
  const sessionRoot = resolveSessionRoot(snapshot.sessionId, userId);
  const payload = `${JSON.stringify(snapshot, null, 2)}\n`;

  await fs.mkdir(sessionRoot, { recursive: true });

  if (options?.createOnly) {
    try {
      await fs.writeFile(filePath, payload, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `Daytona runtime CAS conflict for ${snapshot.sessionId} (create lost race)`,
        );
      }
      throw error;
    }
    return;
  }

  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmpPath, payload, "utf8");
  await fs.rename(tmpPath, filePath);
}

export async function deleteRuntimeLocal(
  sessionId: string,
  userId: string | null = null,
): Promise<void> {
  try {
    await fs.unlink(getRuntimeFilePath(sessionId, userId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export function defaultLocalSnapshot(sessionId: string): DaytonaRuntimeSnapshot {
  return emptyRuntimeSnapshot(sessionId);
}
