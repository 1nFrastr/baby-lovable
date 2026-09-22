/**
 * Optional: freeze a running sandbox filesystem as a snapshot.
 *
 * Prefer `npm run build:vercel-image` for the durable environment
 * (starter + pnpm + node_modules + warmed `.next/dev`). Snapshots are an extra
 * overlay on top of that image.
 *
 * Usage:
 *   npm run build:vercel-snapshot
 *   npm run build:vercel-snapshot -- --force
 *
 * Prints the snapshot id. Set VERCEL_SANDBOX_SNAPSHOT to reuse it on create.
 */
import "@/lib/load-host-env";

import { Sandbox } from "@vercel/sandbox";

import { vercelAuthOptions } from "@/lib/sandbox/vercel/client";
import {
  getVercelDevPort,
  getVercelSandboxImage,
  isVercelSandboxConfigured,
} from "@/lib/sandbox/vercel/config";

async function main() {
  if (!isVercelSandboxConfigured()) {
    throw new Error(
      "Vercel Sandbox is not configured. Set VERCEL_TOKEN and VERCEL_PROJECT_ID.",
    );
  }

  const force = process.argv.includes("--force") || process.argv.includes("-f");
  const existing = process.env.VERCEL_SANDBOX_SNAPSHOT?.trim();
  if (existing && !force) {
    console.log(
      `VERCEL_SANDBOX_SNAPSHOT already set to ${existing} (pass --force to rebuild)`,
    );
    return;
  }

  const sandbox = await Sandbox.create({
    name: `bl-snapshot-${Date.now().toString(36)}`,
    ports: [getVercelDevPort()],
    timeout: 20 * 60 * 1000,
    persistent: false,
    image: getVercelSandboxImage(),
    ...vercelAuthOptions(),
  });

  try {
    const setup = await sandbox.runCommand({
      cmd: "bash",
      args: [
        "-lc",
        [
          "corepack enable",
          "corepack prepare pnpm@10 --activate",
          "command -v rg >/dev/null || (apt-get update && apt-get install -y ripgrep) || true",
          "pnpm --version",
          "rg --version | head -n 1 || true",
        ].join(" && "),
      ],
    });
    if (setup.exitCode !== 0) {
      throw new Error((await setup.stderr()) || "snapshot setup failed");
    }
    console.log(await setup.stdout());

    const snapshot = await sandbox.snapshot({ expiration: 0 });
    console.log(`Created Vercel snapshot: ${snapshot.snapshotId}`);
    console.log("Set VERCEL_SANDBOX_SNAPSHOT to that id for fast session boots.");
  } catch (error) {
    try {
      await sandbox.stop();
    } catch {
      // ignore
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
