/**
 * Test workspace git-archive export for Daytona:
 * 1) before volume persist → source=sandbox-git
 * 2) after persist → source=volume
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
import {
  DAYTONA_VOLUME_MOUNT,
} from "@/lib/sandbox/daytona/config";
import {
  destroyDaytonaSandbox,
  getOrCreateDaytonaSandbox,
} from "@/lib/sandbox/daytona/sandbox-manager";
import {
  persistDaytonaWorkspaceToVolume,
  volumeHasSource,
} from "@/lib/sandbox/daytona/volume-sync";
import {
  exportWorkspaceArchive,
  type ExportArchiveResult,
} from "@/lib/sandbox/export-archive";
import { createSession, getSession, updateSession } from "@/lib/session/store";

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
    return { session: existing, created: false };
  }

  console.log("Creating daytona session …");
  const session = await createSession({
    title: "export-cli-test",
    sandboxMode: "daytona",
  });
  console.log(`session=${session.id}`);
  return { session, created: true };
}

async function main() {
  if (!isDaytonaConfigured()) {
    console.error("DAYTONA_API_KEY (or DAYTONA_JWT_TOKEN) is required");
    process.exit(1);
  }

  const opts = parseArgs(process.argv.slice(2));
  const { session } = await resolveSession(opts);

  let failed = false;
  try {
    console.log("Bootstrapping / reconnecting sandbox …");
    const sandbox = await getOrCreateDaytonaSandbox(session.id);

    const hasVolumeBefore = await volumeHasSource(sandbox);
    console.log(`volumeHasSource at start: ${hasVolumeBefore}`);

    if (!hasVolumeBefore) {
      console.log("\n[1/2] export before persist (expect sandbox-git) …");
      const sandboxExport = await exportWorkspaceArchive(session.id);
      if (sandboxExport.source !== "sandbox-git") {
        throw new Error(
          `expected source=sandbox-git, got ${sandboxExport.source}`,
        );
      }
      assertZipLooksValid(sandboxExport, "sandbox-git");
      await saveZip(
        opts.outDir,
        `${session.id}-sandbox-git.zip`,
        sandboxExport,
      );

      console.log("\nPersisting workspace → volume …");
      const persisted = await persistDaytonaWorkspaceToVolume(sandbox);
      const hasVolumeAfter = await volumeHasSource(sandbox);
      console.log(`persist=${persisted} volumeHasSource=${hasVolumeAfter}`);
      if (!persisted || !hasVolumeAfter) {
        throw new Error("volume persist failed");
      }
    } else {
      // Resume sessions already have volume SoT — temporarily hide package.json
      // so we can still exercise the sandbox-git fallback path.
      const hidePath = `${DAYTONA_VOLUME_MOUNT}/package.json.__export_test_hide`;
      const pkgPath = `${DAYTONA_VOLUME_MOUNT}/package.json`;
      console.log(
        "\n[1/2] volume already populated — hide package.json to force sandbox-git …",
      );
      await sandbox.sdkSandbox.fs.moveFiles(pkgPath, hidePath);
      try {
        if (await volumeHasSource(sandbox)) {
          throw new Error("volumeHasSource still true after hiding package.json");
        }
        const sandboxExport = await exportWorkspaceArchive(session.id);
        if (sandboxExport.source !== "sandbox-git") {
          throw new Error(
            `expected source=sandbox-git, got ${sandboxExport.source}`,
          );
        }
        assertZipLooksValid(sandboxExport, "sandbox-git");
        await saveZip(
          opts.outDir,
          `${session.id}-sandbox-git.zip`,
          sandboxExport,
        );
      } finally {
        try {
          await sandbox.sdkSandbox.fs.moveFiles(hidePath, pkgPath);
        } catch {
          console.warn("failed to restore volume package.json — re-persisting");
          await persistDaytonaWorkspaceToVolume(sandbox);
        }
      }
    }

    // Sandbox-only marker must not appear in a volume-sourced zip.
    await sandbox.fs.writeTextFile(
      "EXPORT_SANDBOX_ONLY.txt",
      "should-not-appear-in-volume-export\n",
    );
    await updateSession(session.id, {
      title: session.title.includes("export")
        ? session.title
        : "export-cli-test-after-persist",
    });

    console.log("\n[2/2] export with volume SoT (expect volume) …");
    const volumeExport = await exportWorkspaceArchive(session.id);
    if (volumeExport.source !== "volume") {
      throw new Error(`expected source=volume, got ${volumeExport.source}`);
    }
    assertZipLooksValid(volumeExport, "volume");
    const volumeHaystack = Buffer.from(volumeExport.bytes).toString("latin1");
    if (volumeHaystack.includes("EXPORT_SANDBOX_ONLY.txt")) {
      throw new Error(
        "volume export unexpectedly includes sandbox-only file — SoT fallback broken?",
      );
    }
    console.log("  ✓ volume zip excludes sandbox-only marker file");
    await saveZip(opts.outDir, `${session.id}-volume.zip`, volumeExport);

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
        await destroyDaytonaSandbox(session.id);
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
