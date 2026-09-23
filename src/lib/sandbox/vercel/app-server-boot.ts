import type { Sandbox } from "@vercel/sandbox";

import { withVercelAllowedDevOrigin } from "./allowed-dev-origin";
import { getVercelDevPort } from "./config";
import {
  stopTrackedDevCommand,
  vercelDevLaunch,
  vercelDevPortFreeProgram,
} from "./dev-process";
import { asVercelProject, VercelProjectSandbox } from "./provider";
import type { ProjectSandbox } from "../types";

export function formatVercelStartError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const trimmed = raw.trim();
  return trimmed.length > 0
    ? trimmed.slice(0, 500)
    : "Vercel preview failed to start. Please try again later.";
}

async function persistedDevCmdId(sessionId: string): Promise<string | null> {
  try {
    const { getRuntimeSnapshot } = await import("../daytona/runtime-store");
    const snap = await getRuntimeSnapshot(sessionId, null, { fresh: true });
    return snap.devCmdId;
  } catch {
    return null;
  }
}

async function killPersistedDevCommand(
  sdk: Sandbox,
  sessionId: string,
): Promise<void> {
  const cmdId = await persistedDevCmdId(sessionId);
  console.warn(
    `[vercel] session=${sessionId} preview stop cmdId=${cmdId ?? "none"}`,
  );
  await stopTrackedDevCommand(sdk, cmdId);
}

/** After Command.kill, refuse to start another listener while :port is taken. */
async function assertDevPortFree(sdk: Sandbox, port: number): Promise<void> {
  const probe = await sdk.runCommand({
    cmd: "node",
    args: ["-e", vercelDevPortFreeProgram(), "--", String(port), "5000"],
    timeoutMs: 15_000,
  });
  if (probe.exitCode !== 0) {
    throw new Error(
      `Dev port ${port} is still in use after stopping the previous preview command.`,
    );
  }
}

async function ensureVercelAllowedDevOrigins(
  project: ProjectSandbox,
): Promise<void> {
  try {
    const current = await project.fs.readTextFile("next.config.ts");
    const next = withVercelAllowedDevOrigin(current);
    if (next !== current) {
      await project.fs.writeTextFile("next.config.ts", next);
    }
  } catch {
    // missing / unreadable config — start anyway
  }
}

export async function startVercelDevSession(
  project: ProjectSandbox,
  sessionId: string,
): Promise<{ sessionName: string; port: number; cmdId: string | null }> {
  const vercel = asVercelProject(project);
  const port = getVercelDevPort();
  const launch = vercelDevLaunch(port);
  console.warn(
    `[vercel] session=${sessionId} preview ${launch.args.slice(3).join(" ")}`,
  );

  await ensureVercelAllowedDevOrigins(project);
  await killPersistedDevCommand(vercel.sdkSandbox, sessionId);
  await assertDevPortFree(vercel.sdkSandbox, port);

  const detached = await vercel.sdkSandbox.runCommand({
    cmd: launch.cmd,
    args: launch.args,
    cwd: launch.cwd,
    detached: true,
  });

  return {
    sessionName: "preview",
    port,
    cmdId: detached.cmdId ?? null,
  };
}

export async function stopVercelDevSession(
  project: ProjectSandbox | null,
  sessionId: string,
): Promise<void> {
  if (!project) {
    return;
  }
  try {
    await killPersistedDevCommand(
      asVercelProject(project).sdkSandbox,
      sessionId,
    );
  } catch {
    // Stop and delete must not stick on a command that is already gone.
  }
}

/** SDK `onResume` — restart pnpm after a persistent sandbox wakes from stop. */
export async function resumeVercelPreview(
  sessionId: string,
  sdk: Sandbox,
): Promise<void> {
  const project = new VercelProjectSandbox(sessionId, sdk);
  const started = await startVercelDevSession(project, sessionId);
  try {
    const { getRuntimeSnapshot, upsertRuntimeSnapshot } = await import(
      "../daytona/runtime-store"
    );
    const snap = await getRuntimeSnapshot(sessionId, null, { fresh: true });
    await upsertRuntimeSnapshot(sessionId, {
      expectedRevision: snap.revision,
      devSessionName: started.sessionName,
      devCmdId: started.cmdId,
    });
  } catch {
    // CAS loss is fine — reconciler will startDev and persist cmdId.
  }
}
