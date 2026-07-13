import path from "node:path";

import { Image } from "@daytona/sdk";

import { DAYTONA_WORKSPACE_ROOT } from "./config";

/** Pinned tag — Daytona rejects floating tags like `latest` / `lts`. */
export const DAYTONA_STARTER_BASE_IMAGE = "node:22.14.0-bookworm";

export const DAYTONA_STARTER_PNPM_VERSION = "10.12.1";

/**
 * Declarative image for the baby-lovable Next.js starter:
 * Node + git + pnpm, starter sources under workspace, deps preinstalled.
 */
export function buildStarterSnapshotImage(repoRoot = process.cwd()): Image {
  const starterDir = path.join(repoRoot, "templates", "nextjs-starter");

  return Image.base(DAYTONA_STARTER_BASE_IMAGE)
    .runCommands(
      "apt-get update " +
        "&& apt-get install -y --no-install-recommends git ca-certificates " +
        "&& rm -rf /var/lib/apt/lists/*",
      `corepack enable && corepack prepare pnpm@${DAYTONA_STARTER_PNPM_VERSION} --activate`,
    )
    .addLocalDir(starterDir, DAYTONA_WORKSPACE_ROOT)
    .workdir(DAYTONA_WORKSPACE_ROOT)
    .runCommands("pnpm install --frozen-lockfile")
    .workdir("/home/daytona");
}
