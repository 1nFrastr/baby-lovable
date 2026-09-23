import { resolvePackageManager } from "../package-manager";
import { VERCEL_WORKSPACE_ROOT } from "./config";

/** How long the supervisor waits before SIGKILL of the dev process group. */
export const VERCEL_DEV_GROUP_KILL_MS = 3_000;

/** Host wait for `command.kill` + supervisor exit, longer than the group SIGKILL. */
export const VERCEL_DEV_STOP_WAIT_MS = 8_000;

export interface TrackedDevCommand {
  exitCode: number | null;
  kill(signal: "SIGTERM" | "SIGKILL"): Promise<void>;
  wait(params?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface TrackedDevSandbox {
  getCommand(cmdId: string): Promise<TrackedDevCommand>;
}

/**
 * Node supervisor launched as the sandbox command.
 * `detached: true` puts `pnpm dev` in its own session. SIGTERM from
 * `Command.kill` hits this process, which signals the whole group so
 * `next-server` cannot keep `:port`.
 *
 * argv after `--` is the dev command. The script text is not in argv.
 */
export function vercelDevSupervisorProgram(): string {
  return `
const { spawn } = require("node:child_process");
const argv = process.argv.slice(1);
const dash = argv.indexOf("--");
const cmdArgs = dash >= 0 ? argv.slice(dash + 1) : argv;
if (cmdArgs.length === 0) {
  console.error("missing dev command");
  process.exit(1);
}
const child = spawn(cmdArgs[0], cmdArgs.slice(1), {
  stdio: "inherit",
  detached: true,
});
let stopping = false;
function killGroup(signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch {}
}
function shutdown() {
  if (stopping) return;
  stopping = true;
  killGroup("SIGTERM");
  const timer = setTimeout(() => {
    killGroup("SIGKILL");
    process.exit(0);
  }, ${VERCEL_DEV_GROUP_KILL_MS});
  child.once("exit", () => {
    clearTimeout(timer);
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
child.on("error", (error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
child.on("exit", (code) => {
  if (!stopping) process.exit(code == null ? 1 : code);
});
`.trim();
}

/** Exit 0 once nothing is listening on the port. Exit 1 if it stays busy. */
export function vercelDevPortFreeProgram(): string {
  return `
const net = require("node:net");
const port = Number(process.argv[1]);
const timeoutMs = Number(process.argv[2] || 5000);
function tryBind(host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    const opts = { port, host };
    if (host === "::") opts.ipv6Only = false;
    server.once("error", (error) => {
      resolve(error && error.code === "EADDRINUSE" ? "busy" : "unsupported");
    });
    server.once("listening", () => {
      server.close(() => resolve("free"));
    });
    server.listen(opts);
  });
}
async function busy() {
  const v6 = await tryBind("::");
  const v4 = await tryBind("0.0.0.0");
  return v6 === "busy" || v4 === "busy";
}
(async () => {
  const start = Date.now();
  for (;;) {
    if (!(await busy())) process.exit(0);
    if (Date.now() - start >= timeoutMs) process.exit(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
})().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
`.trim();
}

export function vercelDevLaunch(port: number): {
  cmd: string;
  args: string[];
  cwd: string;
} {
  const parts = resolvePackageManager().dev(port).split(/\s+/);
  return {
    cmd: "node",
    args: ["-e", vercelDevSupervisorProgram(), "--", ...parts],
    cwd: VERCEL_WORKSPACE_ROOT,
  };
}

/**
 * Stop the preview command the SDK is tracking.
 * No-op when the id is missing or the command has already exited.
 */
export async function stopTrackedDevCommand(
  sdk: TrackedDevSandbox,
  cmdId: string | null,
): Promise<void> {
  if (!cmdId) {
    return;
  }
  let command: TrackedDevCommand;
  try {
    command = await sdk.getCommand(cmdId);
  } catch {
    return;
  }
  if (command.exitCode != null) {
    return;
  }
  try {
    await command.kill("SIGTERM");
  } catch {
    return;
  }
  try {
    await command.wait({
      signal: AbortSignal.timeout(VERCEL_DEV_STOP_WAIT_MS),
    });
  } catch {
    try {
      await command.kill("SIGKILL");
      await command.wait({ signal: AbortSignal.timeout(3_000) });
    } catch {
      // The port probe after this decides whether start is safe.
    }
  }
}
