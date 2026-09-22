import type { Sandbox } from "@vercel/sandbox";

import { resolvePackageManager } from "../package-manager";
import { getVercelDevPort, VERCEL_WORKSPACE_ROOT } from "./config";
import { asVercelProject, VercelProjectSandbox } from "./provider";
import type { ProjectSandbox } from "../types";

export function formatVercelStartError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const trimmed = raw.trim();
  return trimmed.length > 0
    ? trimmed.slice(0, 500)
    : "Vercel preview failed to start. Please try again later.";
}

async function killVercelDev(sdk: Sandbox): Promise<void> {
  try {
    await sdk.runCommand({
      cmd: "bash",
      args: ["-lc", "pkill -f 'pnpm dev' || pkill -f 'next dev' || true"],
      timeoutMs: 15_000,
    });
  } catch {
    // best effort
  }
}

export async function startVercelDevSession(
  project: ProjectSandbox,
  sessionId: string,
): Promise<{ sessionName: string; port: number; cmdId: string | null }> {
  const vercel = asVercelProject(project);
  const port = getVercelDevPort();
  const pm = resolvePackageManager();
  const command = pm.dev(port);
  console.warn(`[vercel] session=${sessionId} preview ${command}`);

  await killVercelDev(vercel.sdkSandbox);

  const detached = await vercel.sdkSandbox.runCommand({
    cmd: "bash",
    args: ["-lc", `cd ${JSON.stringify(VERCEL_WORKSPACE_ROOT)} && ${command}`],
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
  console.warn(`[vercel] session=${sessionId} preview stop`);
  await killVercelDev(asVercelProject(project).sdkSandbox);
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
