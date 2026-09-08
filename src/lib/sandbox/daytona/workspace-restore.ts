/**
 * Restore a snapshot VM after Freestyle hydrate.
 *
 * Snapshot bakes starter deps for cold start. Recreate pulls session source
 * (including pnpm-lock.yaml) but not node_modules — install from the lockfile.
 */
import { logDaytonaBootstrap, logDaytonaTiming } from "./bootstrap-log";
import type { DaytonaProjectSandbox } from "./provider";
import { resolvePackageManager } from "../package-manager";

/** Generous enough for incremental install on top of snapshot node_modules. */
const INSTALL_TIMEOUT_SEC = 180;

const restoreInFlight = new Map<
  string,
  Promise<{ ok: true } | { ok: false; error: string }>
>();

export async function installWorkspaceFromLockfile(
  sandbox: DaytonaProjectSandbox,
  sessionId: string,
): Promise<void> {
  const command = resolvePackageManager().installFrozen;
  logDaytonaBootstrap(sessionId, "restore", command);
  const t0 = Date.now();
  const result = await sandbox.process.executeCommand(
    command,
    ".",
    undefined,
    INSTALL_TIMEOUT_SEC,
  );
  logDaytonaTiming(
    sessionId,
    "action.installLockfile",
    Date.now() - t0,
    `exit=${result.exitCode}`,
  );
  if (result.exitCode !== 0) {
    const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
      .trim()
      .slice(-2000);
    throw new Error(
      `${command} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`,
    );
  }
}

/**
 * Pull Freestyle `main`, install from the committed lockfile, drop starter `.next`.
 * Reconciler calls this on sandbox recreate only — not on snapshot cold start.
 */
export async function restoreHydratedWorkspace(
  sessionId: string,
  project: DaytonaProjectSandbox,
  userId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const pending = restoreInFlight.get(sessionId);
  if (pending) {
    return pending;
  }

  const work = (async () => {
    const { hydrateWorkspaceFromFreestyle } = await import(
      "@/lib/git/hydrate-workspace"
    );
    const tHydrate = Date.now();
    const hydrate = await hydrateWorkspaceFromFreestyle(
      sessionId,
      project,
      userId,
    );
    logDaytonaTiming(
      sessionId,
      "action.hydrateFreestyle",
      Date.now() - tHydrate,
      `ok=${hydrate.ok} mode=${hydrate.mode}`,
    );
    if (!hydrate.ok) {
      return {
        ok: false as const,
        error: hydrate.error ?? "Freestyle workspace hydrate failed",
      };
    }

    try {
      await installWorkspaceFromLockfile(project, sessionId);
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      await project.process.executeCommand("rm -rf .next", ".", undefined, 60);
    } catch {
      // Snapshot Turbopack cache is starter-only; rebuild if unlink fails.
    }
    return { ok: true as const };
  })();

  restoreInFlight.set(sessionId, work);
  try {
    return await work;
  } finally {
    if (restoreInFlight.get(sessionId) === work) {
      restoreInFlight.delete(sessionId);
    }
  }
}

export function isWorkspaceRestoreInFlight(sessionId: string): boolean {
  return restoreInFlight.has(sessionId);
}

export function clearWorkspaceRestoreForTests(): void {
  restoreInFlight.clear();
}
