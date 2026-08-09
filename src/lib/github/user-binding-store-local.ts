import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { getDataRoot } from "@/lib/sandbox/paths";

import {
  normalizeGithubAppUserBinding,
  type GithubAppUserBinding,
} from "./user-binding";

function bindingPath(userId: string): string {
  return path.join(getDataRoot(), "users", userId, "github-app.json");
}

export async function readGithubAppUserBindingLocal(
  userId: string,
): Promise<GithubAppUserBinding | null> {
  try {
    const raw = await readFile(bindingPath(userId), "utf8");
    return normalizeGithubAppUserBinding(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeGithubAppUserBindingLocal(
  binding: GithubAppUserBinding,
): Promise<GithubAppUserBinding> {
  const filePath = bindingPath(binding.userId);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  const payload: GithubAppUserBinding = {
    ...binding,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
  return payload;
}

export async function deleteGithubAppUserBindingLocal(
  userId: string,
): Promise<void> {
  const { unlink } = await import("node:fs/promises");
  try {
    await unlink(bindingPath(userId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
