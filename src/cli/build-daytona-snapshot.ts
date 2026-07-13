/**
 * Build (or rebuild) the Daytona snapshot used for cold-start sandboxes.
 *
 * Usage:
 *   npm run build:daytona-snapshot
 *   npm run build:daytona-snapshot -- --force
 *   npm run build:daytona-snapshot -- --name my-snapshot
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

import {
  DAYTONA_DEFAULT_SNAPSHOT,
  getDaytonaSnapshotName,
} from "@/lib/sandbox/daytona/config";
import { getDaytonaClient } from "@/lib/sandbox/daytona/client";
import {
  DAYTONA_STARTER_BASE_IMAGE,
  buildStarterSnapshotImage,
} from "@/lib/sandbox/daytona/snapshot-image";
import type { Daytona } from "@daytona/sdk";

function parseArgs(argv: string[]): { force: boolean; name: string } {
  let force = false;
  let name = getDaytonaSnapshotName() ?? DAYTONA_DEFAULT_SNAPSHOT;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force" || arg === "-f") {
      force = true;
      continue;
    }
    if ((arg === "--name" || arg === "-n") && argv[i + 1]) {
      name = argv[++i]!;
      continue;
    }
  }
  return { force, name };
}

async function getSnapshotOrNull(daytona: Daytona, name: string) {
  try {
    return await daytona.snapshot.get(name);
  } catch {
    return null;
  }
}

async function waitUntilSnapshotGone(
  daytona: Daytona,
  name: string,
  maxWaitMs = 120_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    const current = await getSnapshotOrNull(daytona, name);
    if (!current) {
      return;
    }
    console.log(`Waiting for snapshot delete (state=${current.state})…`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Timed out waiting for snapshot "${name}" to be deleted`);
}

async function main(): Promise<void> {
  if (!process.env.DAYTONA_API_KEY && !process.env.DAYTONA_JWT_TOKEN) {
    throw new Error("DAYTONA_API_KEY (or DAYTONA_JWT_TOKEN) is required");
  }

  const { force, name } = parseArgs(process.argv.slice(2));
  const daytona = getDaytonaClient();

  const existing = await getSnapshotOrNull(daytona, name);
  if (existing) {
    if (!force) {
      console.log(
        `Snapshot "${name}" already exists (state=${existing.state}). Re-run with --force to rebuild.`,
      );
      return;
    }
    console.log(`Deleting existing snapshot "${name}"…`);
    await daytona.snapshot.delete(existing);
    await waitUntilSnapshotGone(daytona, name);
  }

  console.log(`Building snapshot "${name}" from ${DAYTONA_STARTER_BASE_IMAGE}…`);
  const image = buildStarterSnapshotImage();

  const snapshot = await daytona.snapshot.create(
    {
      name,
      image,
      resources: {
        cpu: 2,
        memory: 4,
        disk: 8,
      },
    },
    {
      onLogs: (chunk) => process.stdout.write(chunk),
      timeout: 0,
    },
  );

  console.log(
    `\nSnapshot ready: ${snapshot.name} (state=${snapshot.state}, id=${snapshot.id})`,
  );
  console.log(`Set DAYTONA_SNAPSHOT=${snapshot.name} (default already matches).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
