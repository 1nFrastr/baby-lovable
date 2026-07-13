#!/usr/bin/env tsx
/**
 * Kill orphaned session preview dev servers (pnpm dev / next dev / next-server)
 * under .baby-lovable/sessions/<id>/workspace. Does not touch the host app (npm run dev).
 *
 * Also catches detached next-server orphans (PPID=1) whose command line no longer
 * includes the session path — detected via process cwd instead.
 *
 * Usage:
 *   npm run cleanup-previews
 *   npm run cleanup-previews -- --dry-run
 *   npm run cleanup-previews -- --keep sess_abc123
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DATA_ROOT = process.env.BABY_LOVABLE_DATA_DIR ?? ".baby-lovable";
const SESSIONS_ROOT = path.resolve(process.cwd(), DATA_ROOT, "sessions");
const SESSION_MARKER = /\.baby-lovable\/sessions\/([^/]+)\/workspace/;

const ORPHAN_COMMAND =
  /\bnext-server\b|\.next\/dev\/build\/|node.*\/next\/dist\/bin\/next dev/;

interface ProcessInfo {
  pid: number;
  command: string;
  sessionId: string | null;
  source: "command" | "cwd";
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

function sessionIdFromPath(targetPath: string): string | null {
  const relative = path.relative(SESSIONS_ROOT, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  const sessionId = relative.split(path.sep)[0];
  return sessionId?.startsWith("sess_") ? sessionId : null;
}

function sessionIdFromCommand(command: string): string | null {
  return command.match(SESSION_MARKER)?.[1] ?? null;
}

async function getProcessCwd(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("lsof", [
      "-a",
      "-p",
      String(pid),
      "-d",
      "cwd",
      "-Fn",
    ]);
    for (const line of stdout.split("\n")) {
      if (line.startsWith("n")) {
        return line.slice(1);
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function listProcesses(): Promise<ProcessInfo[]> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="]);
  const byPid = new Map<number, ProcessInfo>();

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(/^(\d+)\s+(.+)$/);
    if (!match) continue;

    const pid = Number(match[1]);
    const command = match[2];
    if (!Number.isFinite(pid) || pid <= 0) continue;

    const sessionId = sessionIdFromCommand(command);
    if (sessionId) {
      byPid.set(pid, { pid, command, sessionId, source: "command" });
      continue;
    }

    if (!ORPHAN_COMMAND.test(command)) {
      continue;
    }

    const cwd = await getProcessCwd(pid);
    if (!cwd) continue;

    const sessionIdFromCwd = sessionIdFromPath(cwd);
    if (!sessionIdFromCwd) continue;

    byPid.set(pid, {
      pid,
      command,
      sessionId: sessionIdFromCwd,
      source: "cwd",
    });
  }

  return [...byPid.values()];
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

function isHostAppProcess(command: string, cwd: string | null): boolean {
  if (sessionIdFromCommand(command)) {
    return false;
  }

  const hostRoot = process.cwd();
  if (command.includes(`${hostRoot}/node_modules`) && /\bnext dev\b/.test(command)) {
    return true;
  }

  if (cwd && path.resolve(cwd) === hostRoot) {
    return true;
  }

  return false;
}

async function main(): Promise<void> {
  const { dryRun, keepSessions } = parseArgs();
  const processes = await listProcesses();

  const filtered: ProcessInfo[] = [];
  for (const proc of processes) {
    const cwd = proc.source === "cwd" ? await getProcessCwd(proc.pid) : null;
    if (isHostAppProcess(proc.command, cwd)) {
      continue;
    }
    filtered.push(proc);
  }

  if (filtered.length === 0) {
    console.log("No session preview processes found.");
    return;
  }

  const bySession = new Map<string, ProcessInfo[]>();
  for (const proc of filtered) {
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
    `Found ${filtered.length} session preview process(es) across ${bySession.size} session(s).`,
  );

  for (const proc of targets) {
    const label = proc.sessionId ? `[${proc.sessionId}]` : "[unknown]";
    const via = proc.source === "cwd" ? " (cwd orphan)" : "";
    console.log(
      `${dryRun ? "Would kill" : "Killing"} ${label}${via} pid=${proc.pid}`,
    );
    if (!dryRun) {
      await killProcessTree(proc.pid, "SIGTERM");
    }
  }

  if (dryRun) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 500));

  const remaining = (await listProcesses()).filter((proc) => {
    if (proc.sessionId && keepSessions.has(proc.sessionId)) {
      return false;
    }
    return !isHostAppProcess(proc.command, null);
  });

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

  const stillRunning = (await listProcesses()).filter(
    (proc) => proc.sessionId && !keepSessions.has(proc.sessionId),
  );

  if (stillRunning.length === 0) {
    console.log("Cleanup complete.");
  } else {
    console.warn(`Warning: ${stillRunning.length} process(es) could not be stopped.`);
    for (const proc of stillRunning) {
      console.warn(`  pid=${proc.pid} ${proc.command.slice(0, 120)}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
