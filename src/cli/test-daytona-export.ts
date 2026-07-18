/**
 * Test workspace git-archive export for Daytona (sandbox local FS).
 *
 * Usage:
 *   npm run test:daytona-export
 *   npm run test:daytona-export -- -s sess_xxx
 *   npm run test:daytona-export -- --out /tmp/exports
 *   npm run test:daytona-export -- --skip-cleanup
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

import { isDaytonaConfigured } from "@/lib/sandbox/daytona/config";
import { deleteDaytonaSandbox } from "@/lib/sandbox/daytona/sandbox";
import { ensureDesiredState } from "@/lib/sandbox/daytona/runtime-reconciler";
import {
  exportWorkspaceArchive,
  type ExportArchiveResult,
} from "@/lib/sandbox/daytona/export-archive";
import { createSession, getSession } from "@/lib/session/store";

interface CliOpts {
  sessionId?: string;
  outDir: string;
  skipCleanup: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    outDir: path.resolve(".baby-lovable/exports"),
    skipCleanup: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-s" || arg === "--session") {
      opts.sessionId = argv[++i];
    } else if (arg === "--out") {
      opts.outDir = path.resolve(argv[++i] ?? opts.outDir);
    } else if (arg === "--skip-cleanup") {
      opts.skipCleanup = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(`Usage: npm run test:daytona-export -- [options]

Options:
  -s, --session <id>   Reuse an existing daytona session
  --out <dir>          Where to write zip artifacts (default: .baby-lovable/exports)
  --skip-cleanup       Do not destroy the daytona sandbox on exit
  -h, --help           Show help`);
      process.exit(0);
    }
  }

  return opts;
}

function assertZipLooksValid(result: ExportArchiveResult, label: string): void {
  const { bytes, filename, source } = result;
  if (bytes.byteLength < 64) {
    throw new Error(`${label}: zip too small (${bytes.byteLength} bytes)`);
  }
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error(
      `${label}: missing ZIP magic (got ${bytes[0]},${bytes[1]})`,
    );
  }
  const haystack = Buffer.from(bytes).toString("latin1");
  if (!haystack.includes("package.json")) {
    throw new Error(`${label}: zip does not contain package.json entry`);
  }
  console.log(
    `  ✓ ${label}: source=${source} file=${filename} bytes=${bytes.byteLength}`,
  );
}

async function saveZip(
  outDir: string,
  name: string,
  result: ExportArchiveResult,
): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const target = path.join(outDir, name);
  await writeFile(target, result.bytes);
  console.log(`  wrote ${target}`);
  return target;
}

async function resolveSession(opts: CliOpts) {
  if (opts.sessionId) {
    const existing = await getSession(opts.sessionId);
    if (!existing) {
      throw new Error(`Session not found: ${opts.sessionId}`);
    }
    if (existing.sandboxMode !== "daytona") {
      throw new Error(
        `Session ${opts.sessionId} is sandboxMode=${existing.sandboxMode}, need daytona`,
      );
    }
    console.log(`Reusing session=${existing.id}`);
    return existing;
  }

  console.log("Creating daytona session …");
  const session = await createSession({
    title: "export-cli-test",
    sandboxMode: "daytona",
  });
  console.log(`session=${session.id}`);
  return session;
}

async function main() {
  if (!isDaytonaConfigured()) {
    console.error("DAYTONA_API_KEY (or DAYTONA_JWT_TOKEN) is required");
    process.exit(1);
  }

  const opts = parseArgs(process.argv.slice(2));
  const session = await resolveSession(opts);

  let failed = false;
  try {
    console.log("Bootstrapping / reconnecting sandbox …");
    await ensureDesiredState(session.id, "sandbox-ready", { wait: true });

    console.log("\nExport via sandbox-git …");
    const result = await exportWorkspaceArchive(session.id);
    if (result.source !== "sandbox-git") {
      throw new Error(`expected source=sandbox-git, got ${result.source}`);
    }
    assertZipLooksValid(result, "sandbox-git");
    await saveZip(opts.outDir, `${session.id}-sandbox-git.zip`, result);

    console.log("\nPASS");
  } catch (error) {
    failed = true;
    const message = error instanceof Error ? error.message : String(error);
    console.error("\nFAIL", error);
    if (/disk limit exceeded/i.test(message)) {
      console.error(`
Hint: Daytona org disk quota is full. Free space in the dashboard
(https://app.daytona.io/dashboard/limits) or reuse an existing session:

  npm run test:daytona-export -- -s <existing_daytona_session_id>
`);
    }
  } finally {
    if (opts.skipCleanup) {
      console.log("Skipping sandbox cleanup (--skip-cleanup)");
    } else {
      console.log("Cleaning up daytona sandbox …");
      try {
        await deleteDaytonaSandbox(session.id);
      } catch (error) {
        console.warn("sandbox cleanup warning:", error);
      }
    }
  }

  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
