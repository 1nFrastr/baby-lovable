import path from "node:path";

import { Image } from "@daytona/sdk";

import { DAYTONA_WORKSPACE_ROOT } from "./config";

/** Pinned tag — Daytona rejects floating tags like `latest` / `lts`. */
export const DAYTONA_STARTER_BASE_IMAGE = "node:22.14.0-bookworm";

/** Keep in sync with `templates/nextjs-starter/package.json` → `packageManager`. */
export const DAYTONA_STARTER_PNPM_VERSION = "10.12.1";

/**
 * Declarative image for the baby-lovable Next.js starter.
 *
 * Everything the cold-start path needs is baked in at snapshot build time:
 * Node + git + system pnpm + starter sources + `node_modules`.
 * Runtime must not rely on detecting/installing these after sandbox create.
 */
export function buildStarterSnapshotImage(repoRoot = process.cwd()): Image {
  const starterDir = path.join(repoRoot, "templates", "nextjs-starter");

  return Image.base(DAYTONA_STARTER_BASE_IMAGE)
    .runCommands(
      "apt-get update " +
        "&& apt-get install -y --no-install-recommends git ca-certificates " +
        "&& rm -rf /var/lib/apt/lists/*",
      // Global npm install puts pnpm on /usr/local/bin for non-login shells
      // (Daytona process API). Corepack alone can leave shims off PATH in build.
      `npm install -g pnpm@${DAYTONA_STARTER_PNPM_VERSION} ` +
        `&& pnpm --version`,
    )
    .addLocalDir(starterDir, DAYTONA_WORKSPACE_ROOT)
    .workdir(DAYTONA_WORKSPACE_ROOT)
    .runCommands(
      "pnpm install --frozen-lockfile",
      // Fail the snapshot build if deps did not land where runtime expects them.
      "test -f node_modules/next/package.json",
      "test -d node_modules/.pnpm",
      "pnpm --version",
      "node -e \"require('next/package.json')\"",
    )
    .workdir("/home/daytona");
}
