/**
 * Daytona filesystem smoke test — sandbox local disk only (official SDK APIs).
 *
 * Usage:
 *   npx tsx src/cli/test-daytona-fs.ts
 *   npx tsx src/cli/test-daytona-fs.ts --keep   # don't delete sandbox on exit
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

import { Daytona } from "@daytona/sdk";
import type { Sandbox } from "@daytona/sdk";

import { readStarterTemplateFiles } from "@/lib/sandbox/daytona/template-seed";

const WORKSPACE = process.env.DAYTONA_WORKSPACE_ROOT ?? "/home/daytona/workspace";
const DEV_PORT = Number(process.env.DAYTONA_DEV_PORT ?? 3000);

function parseArgs(): { keep: boolean } {
  return { keep: process.argv.slice(2).includes("--keep") };
}

function log(tag: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${tag.padEnd(8)} ${msg}`);
}

function fail(msg: string): never {
  log("FAIL", msg);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// SDK helpers (mirrors official docs patterns)
// ---------------------------------------------------------------------------

function getClient(): Daytona {
  if (!process.env.DAYTONA_API_KEY && !process.env.DAYTONA_JWT_TOKEN) {
    fail("DAYTONA_API_KEY not set in .env.local");
  }
  return new Daytona({
    apiKey: process.env.DAYTONA_API_KEY,
    apiUrl: process.env.DAYTONA_API_URL,
    target: process.env.DAYTONA_TARGET,
  });
}

async function createSandbox(daytona: Daytona): Promise<Sandbox> {
  log("CREATE", "sandbox (local disk) …");
  const sandbox = await daytona.create(
    { language: "typescript", labels: { test: "daytona-fs-local" } },
    { timeout: 180 },
  );
  await sandbox.waitUntilStarted(180);
  return sandbox;
}

/** Upload starter template via SDK — the official way, no rsync. */
async function seedProject(
  sandbox: Sandbox,
  targetDir: string,
): Promise<number> {
  const files = await readStarterTemplateFiles();
  log("UPLOAD", `${files.length} files → ${targetDir} via sandbox.fs.uploadFiles()`);

  const batch = files.map((f) => ({
    source: f.content,
    destination: `${targetDir}/${f.relativePath}`,
  }));

  // SDK bulk upload (official docs: sandbox.fs.uploadFiles)
  await sandbox.fs.uploadFiles(batch);
  return files.length;
}

async function installPnpm(sandbox: Sandbox, cwd: string): Promise<void> {
  log("PNPM", "bootstrap corepack …");
  const boot = await sandbox.process.executeCommand(
    "corepack enable && corepack prepare pnpm@10.12.1 --activate",
    cwd,
    undefined,
    120,
  );
  if (boot.exitCode !== 0) {
    log("PNPM", `corepack failed (exit ${boot.exitCode}): ${boot.result?.slice(-500)}`);
    const fallback = await sandbox.process.executeCommand(
      "npm install -g pnpm@10.12.1",
      cwd,
      undefined,
      120,
    );
    if (fallback.exitCode !== 0) {
      fail(`pnpm bootstrap failed: ${fallback.result?.slice(-500)}`);
    }
  }
  const ver = await sandbox.process.executeCommand("pnpm --version", cwd, undefined, 30);
  log("PNPM", `version ${ver.result?.trim()}`);
}

async function runPnpmInstall(sandbox: Sandbox, cwd: string): Promise<void> {
  log("INSTALL", `pnpm install in ${cwd} …`);
  const result = await sandbox.process.executeCommand(
    "pnpm install",
    cwd,
    undefined,
    600,
  );
  if (result.exitCode !== 0) {
    fail(`pnpm install failed (exit ${result.exitCode}):\n${result.result?.slice(-3000)}`);
  }
  log("INSTALL", "✓ done");

  const check = await sandbox.process.executeCommand(
    "test -d node_modules/next && echo OK",
    cwd,
    undefined,
    30,
  );
  if (!check.result?.includes("OK")) {
    fail("node_modules/next not found after install");
  }
  log("INSTALL", "✓ node_modules/next exists");
}

async function startDevServer(sandbox: Sandbox, cwd: string): Promise<string> {
  const sessionId = "test-dev";
  log("DEV", `starting pnpm dev on port ${DEV_PORT} in ${cwd} …`);

  try {
    await sandbox.process.deleteSession(sessionId);
  } catch {
    // ok
  }
  await sandbox.process.createSession(sessionId);

  const cmd = await sandbox.process.executeSessionCommand(
    sessionId,
    {
      command: `cd ${JSON.stringify(cwd)} && pnpm dev --port ${DEV_PORT}`,
      runAsync: true,
    },
    30,
  );

  log("DEV", `session cmd id=${cmd.cmdId} exitCode=${cmd.exitCode}`);
  if (cmd.stdout) log("DEV", `stdout: ${cmd.stdout.slice(-300)}`);
  if (cmd.stderr) log("DEV", `stderr: ${cmd.stderr.slice(-300)}`);

  // For runAsync=true, exitCode may be set immediately — don't fail here, poll instead.

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const preview = await sandbox.getPreviewLink(DEV_PORT);
      const probe = await fetch(preview.url, {
        headers: { "x-daytona-preview-token": preview.token },
        signal: AbortSignal.timeout(5_000),
      });
      if (probe.status < 600) {
        log("DEV", `✓ preview ready — HTTP ${probe.status}`);
        log("DEV", `  URL: ${preview.url}`);
        return preview.url;
      }
    } catch {
      // warming up
    }

    if (cmd.cmdId) {
      try {
        const logs = await sandbox.process.getSessionCommandLogs(
          sessionId,
          cmd.cmdId,
        );
        const tail = (logs.stdout ?? "") + (logs.stderr ?? "");
        if (tail.includes("Ready") || tail.includes("ready")) {
          log("DEV", "log shows ready, probing …");
        }
        if (tail.includes("Error") || tail.includes("error")) {
          log("DEV", `log snippet: ${tail.slice(-500)}`);
        }
      } catch {
        // logs not ready
      }
    }

    await new Promise((r) => setTimeout(r, 3_000));
  }

  if (cmd.cmdId) {
    try {
      const logs = await sandbox.process.getSessionCommandLogs(sessionId, cmd.cmdId);
      fail(`dev server timeout. Logs:\n${(logs.stdout ?? "") + (logs.stderr ?? "")}`.slice(-4000));
    } catch {
      fail("dev server timeout (no logs)");
    }
  }
  fail("dev server timeout");
}

async function main() {
  const { keep } = parseArgs();
  log("INFO", `workspace=${WORKSPACE}  port=${DEV_PORT}`);

  const daytona = getClient();
  let sandbox: Sandbox | null = null;

  try {
    sandbox = await createSandbox(daytona);
    log("SANDBOX", `id=${sandbox.id}  state=${sandbox.state}`);

    const probe = await sandbox.process.executeCommand("pwd && ls -la", ".", undefined, 30);
    log("PROBE", probe.result?.trim().split("\n").slice(0, 5).join(" | "));

    await seedProject(sandbox, WORKSPACE);
    await installPnpm(sandbox, WORKSPACE);
    await runPnpmInstall(sandbox, WORKSPACE);
    await startDevServer(sandbox, WORKSPACE);

    log("PASS", "All checks passed");
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    if (sandbox && !keep) {
      log("CLEANUP", `deleting sandbox ${sandbox.id} …`);
      try {
        await sandbox.delete(60);
      } catch {
        log("CLEANUP", "delete failed (may already be gone)");
      }
    } else if (sandbox) {
      log("KEEP", `sandbox ${sandbox.id} left running (--keep)`);
    }
  }
}

main();
