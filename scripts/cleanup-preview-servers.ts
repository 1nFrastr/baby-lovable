#!/usr/bin/env tsx
/**
 * Kill orphaned session preview dev servers (pnpm dev / next dev / next-server)
 * under .baby-lovable/sessions/<id>/workspace. Does not touch the host app (npm run dev).
 *
 * Usage:
 *   npm run cleanup-previews
 *   npm run cleanup-previews -- --dry-run
 *   npm run cleanup-previews -- --keep sess_abc123
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SESSION_MARKER = /\.baby-lovable\/sessions\/([^/]+)\/workspace/;

interface ProcessInfo {
  pid: number;
  command: string;
  sessionId: string | null;
}

function parseArgs(): { dryRun: boolean; keepSessions: Set<string> } {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const keepSessions = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--keep" && args[i + 1]) {
      keepSessions.add(args[i + 1]);
      i++;
    }
  }

  return { dryRun, keepSessions };
}

async function listProcesses(): Promise<ProcessInfo[]> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="]);
  const processes: ProcessInfo[] = [];

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(/^(\d+)\s+(.+)$/);
    if (!match) continue;

    const pid = Number(match[1]);
    const command = match[2];
    if (!Number.isFinite(pid) || pid <= 0) continue;

    const sessionMatch = command.match(SESSION_MARKER);
    if (!sessionMatch) continue;

    processes.push({
      pid,
      command,
      sessionId: sessionMatch[1],
    });
  }

  return processes;
}

async function killProcessTree(
  pid: number,
  signal: NodeJS.Signals,
): Promise<void> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-P", String(pid)]);
    const children = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((child) => Number(child))
      .filter((child) => Number.isFinite(child) && child > 0);

    await Promise.all(children.map((child) => killProcessTree(child, signal)));
  } catch {
    // No child processes.
  }

  try {
    process.kill(pid, signal);
  } catch {
    // Already exited.
  }
}

function isPreviewLeader(command: string): boolean {
  return /\bnext dev\b/.test(command) || /\bpnpm\b.*\bdev\b/.test(command);
}

async function main(): Promise<void> {
  const { dryRun, keepSessions } = parseArgs();
  const processes = await listProcesses();

  if (processes.length === 0) {
    console.log("No session preview processes found.");
    return;
  }

  const bySession = new Map<string, ProcessInfo[]>();
  for (const proc of processes) {
    if (!proc.sessionId) continue;
    const list = bySession.get(proc.sessionId) ?? [];
    list.push(proc);
    bySession.set(proc.sessionId, list);
  }

  const leaders: ProcessInfo[] = [];
  const stragglers: ProcessInfo[] = [];

  for (const [sessionId, procs] of bySession) {
    if (keepSessions.has(sessionId)) {
      console.log(`Keeping session ${sessionId} (${procs.length} process(es))`);
      continue;
    }

    const sessionLeaders = procs.filter((proc) => isPreviewLeader(proc.command));
    if (sessionLeaders.length > 0) {
      leaders.push(...sessionLeaders);
    } else {
      stragglers.push(...procs);
    }
  }

  const targets = [...leaders, ...stragglers];
  if (targets.length === 0) {
    console.log("Nothing to kill (all matched sessions are kept).");
    return;
  }

  console.log(
    `Found ${processes.length} session preview process(es) across ${bySession.size} session(s).`,
  );

  for (const proc of targets) {
    const label = proc.sessionId ? `[${proc.sessionId}]` : "[unknown]";
    console.log(`${dryRun ? "Would kill" : "Killing"} ${label} pid=${proc.pid}`);
    if (!dryRun) {
      await killProcessTree(proc.pid, "SIGTERM");
    }
  }

  if (dryRun) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 500));

  const remaining = await listProcesses();
  const toForceKill = remaining.filter(
    (proc) => proc.sessionId && !keepSessions.has(proc.sessionId),
  );

  if (toForceKill.length === 0) {
    console.log("All session preview processes stopped.");
    return;
  }

  console.log(`Force-killing ${toForceKill.length} remaining process(es)...`);
  for (const proc of toForceKill) {
    await killProcessTree(proc.pid, "SIGKILL");
  }

  const stillRunning = await listProcesses();
  const left = stillRunning.filter(
    (proc) => proc.sessionId && !keepSessions.has(proc.sessionId),
  );

  if (left.length === 0) {
    console.log("Cleanup complete.");
  } else {
    console.warn(`Warning: ${left.length} process(es) could not be stopped.`);
    for (const proc of left) {
      console.warn(`  pid=${proc.pid} ${proc.command.slice(0, 120)}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
