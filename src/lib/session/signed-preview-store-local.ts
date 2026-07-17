import fs from "node:fs/promises";
import path from "node:path";

import { resolveSessionRoot } from "@/lib/sandbox/paths";

import type { SignedPreviewCache } from "./signed-preview-store";

function getCacheFilePath(
  sessionId: string,
  userId: string | null = null,
): string {
  return path.join(resolveSessionRoot(sessionId, userId), "signed-preview.json");
}

export async function readSignedPreviewLocal(
  sessionId: string,
  userId: string | null = null,
): Promise<SignedPreviewCache | null> {
  try {
    const raw = await fs.readFile(getCacheFilePath(sessionId, userId), "utf8");
    const parsed = JSON.parse(raw) as SignedPreviewCache;
    if (
      typeof parsed?.url !== "string" ||
      typeof parsed?.sandboxId !== "string" ||
      typeof parsed?.port !== "number" ||
      typeof parsed?.expiresAtMs !== "number"
    ) {
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

export async function writeSignedPreviewLocal(
  sessionId: string,
  entry: SignedPreviewCache,
  userId: string | null = null,
): Promise<void> {
  const filePath = getCacheFilePath(sessionId, userId);
  const tmpPath = `${filePath}.tmp`;
  const sessionRoot = resolveSessionRoot(sessionId, userId);

  await fs.mkdir(sessionRoot, { recursive: true });
  await fs.writeFile(tmpPath, `${JSON.stringify(entry)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

export async function clearSignedPreviewLocal(
  sessionId: string,
  userId: string | null = null,
): Promise<void> {
  try {
    await fs.unlink(getCacheFilePath(sessionId, userId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
