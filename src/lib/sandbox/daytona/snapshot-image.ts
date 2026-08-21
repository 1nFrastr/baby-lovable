import path from "node:path";

import { Image } from "@daytona/sdk";

import { DAYTONA_WORKSPACE_ROOT, getDaytonaDevPort } from "./config";

/** Pinned tag — Daytona rejects floating tags like `latest` / `lts`. */
export const DAYTONA_STARTER_BASE_IMAGE = "node:22.14.0-bookworm";

/** Keep in sync with `templates/nextjs-starter/package.json` → `packageManager`. */
export const DAYTONA_STARTER_PNPM_VERSION = "10.12.1";

/** Warm script path inside the snapshot workspace (not part of Freestyle seed). */
export const NEXT_DEV_WARM_SCRIPT = "scripts/warm-next-dev.sh";

function warmScriptLocalPath(repoRoot = process.cwd()): string {
  // Prefer repo-relative path; fall back to module-adjacent for odd CWD.
  const fromRepo = path.join(
    repoRoot,
    "src/lib/sandbox/daytona/scripts/warm-next-dev.sh",
  );
  return fromRepo;
}

/**
 * Commands that assert deps then warm `.next/dev` via one-shot `pnpm dev` + HTTP.
 * `next build` does NOT warm `next dev` — caches are separate.
 */
export function buildNextDevWarmCommands(port = getDaytonaDevPort()): string[] {
  return [
    // Fail the snapshot build if deps did not land where runtime expects them.
    "test -f node_modules/next/package.json",
    "test -d node_modules/.pnpm",
    "pnpm --version",
    "node -e \"require('next/package.json')\"",
    `chmod +x ${NEXT_DEV_WARM_SCRIPT}`,
    `bash ${NEXT_DEV_WARM_SCRIPT} ${port}`,
    // Do not ship the warm helper into runtime sandboxes' working tree noise.
    `rm -f ${NEXT_DEV_WARM_SCRIPT}`,
  ];
}

/**
 * Declarative image for the baby-lovable Next.js starter.
 *
 * Everything the cold-start path needs is baked in at snapshot build time:
 * Node + git + system pnpm + starter sources + `node_modules` + `.next/dev`
 * (Turbopack filesystem cache from a one-shot `pnpm dev` + HTTP hit).
 * Runtime must not rely on detecting/installing these after sandbox create.
 */
export function buildStarterSnapshotImage(repoRoot = process.cwd()): Image {
  const starterDir = path.join(repoRoot, "templates", "nextjs-starter");
  const warmScript = warmScriptLocalPath(repoRoot);
  const remoteWarm = path.posix.join(DAYTONA_WORKSPACE_ROOT, NEXT_DEV_WARM_SCRIPT);

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
    .addLocalFile(warmScript, remoteWarm)
    .workdir(DAYTONA_WORKSPACE_ROOT)
    .runCommands(
      "pnpm install --frozen-lockfile",
      ...buildNextDevWarmCommands(),
    )
    .workdir("/home/daytona");
}
