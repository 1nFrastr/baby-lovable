import type { Sandbox } from "@vercel/sandbox";

import { VERCEL_WORKSPACE_ROOT } from "./config";

/**
 * Create the process cwd before any `runCommand({ cwd })`.
 *
 * SDK `fs.mkdir` shells `mkdir` with the session default cwd (`/vercel/sandbox`),
 * which does not exist on empty images — that call 400s on chdir. Always mkdir
 * from `/` instead.
 */
export async function ensureVercelWorkspaceRoot(
  sandbox: Sandbox,
): Promise<void> {
  const root = JSON.stringify(VERCEL_WORKSPACE_ROOT);
  const result = await sandbox.runCommand({
    cmd: "bash",
    args: ["-lc", `mkdir -p ${root} && test -d ${root}`],
    cwd: "/",
    timeoutMs: 15_000,
  });
  if (result.exitCode !== 0) {
    const stderr =
      "stderr" in result && typeof result.stderr === "function"
        ? await result.stderr()
        : "";
    throw new Error(
      `Failed to create ${VERCEL_WORKSPACE_ROOT}: ${stderr}`.slice(0, 300),
    );
  }
}
