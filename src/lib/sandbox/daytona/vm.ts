/** Daytona VM: get / wake / create / delete (SDK only — no session persistence). */
import type { Session } from "@/lib/session/types";

import {
  allowDaytonaSnapshotFallback,
  getDaytonaSnapshotName,
} from "./config";
import { getDaytonaClient } from "./client";
import { logDaytonaBootstrap, logDaytonaTiming } from "./bootstrap-log";
import { DaytonaProjectSandbox } from "./provider";
import type { Sandbox } from "@daytona/sdk";

const RECONNECT_ATTEMPTS = 3;

type SandboxApiClient = {
  updatePublicStatus: (
    sandboxIdOrName: string,
    isPublic: boolean,
  ) => Promise<unknown>;
};

export function isAsleep(state: string | undefined): boolean {
  return state === "stopped" || state === "archived";
}

export function wrapSandbox(
  sessionId: string,
  sandbox: Sandbox,
): DaytonaProjectSandbox {
  return new DaytonaProjectSandbox(sessionId, sandbox);
}

/**
 * Public preview ports need no signed URL / token header.
 * Creates are public; migrate older private sandboxes in place.
 */
export async function ensureSandboxPublic(sandbox: Sandbox): Promise<void> {
  if (sandbox.public) {
    return;
  }
  try {
    // SDK Sandbox keeps sandboxApi private; create uses public:true, this migrates older VMs.
    const api = (sandbox as unknown as { sandboxApi: SandboxApiClient }).sandboxApi;
    await api.updatePublicStatus(sandbox.id, true);
    sandbox.public = true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to set Daytona sandbox public: ${detail.slice(0, 200)}`,
    );
  }
}

/** Get sandbox by id. wake=false never starts stopped/archived VMs. */
export async function fetchSandbox(
  sessionId: string,
  sandboxId: string,
  wake: boolean,
): Promise<Sandbox | null> {
  const daytona = getDaytonaClient();
  const t0 = Date.now();
  logDaytonaBootstrap(
    sessionId,
    "sandbox",
    wake ? `reconnect ${sandboxId}` : `peek ${sandboxId}`,
  );

  try {
    const tGet = Date.now();
    const sandbox = await daytona.get(sandboxId);
    logDaytonaTiming(sessionId, "fetchSandbox.get", Date.now() - tGet, `id=${sandboxId} state=${sandbox.state ?? "?"}`);

    if (isAsleep(sandbox.state)) {
      if (!wake) {
        logDaytonaBootstrap(sessionId, "sandbox", `${sandboxId} is ${sandbox.state}`);
        logDaytonaTiming(sessionId, "fetchSandbox.total", Date.now() - t0, "asleep-no-wake");
        return null;
      }
      const tStart = Date.now();
      await sandbox.start(120);
      logDaytonaTiming(sessionId, "fetchSandbox.start", Date.now() - tStart);
    }

    const tWait = Date.now();
    await sandbox.waitUntilStarted(120);
    logDaytonaTiming(sessionId, "fetchSandbox.waitUntilStarted", Date.now() - tWait, `state=${sandbox.state ?? "?"}`);
    logDaytonaTiming(sessionId, "fetchSandbox.total", Date.now() - t0, wake ? "wake" : "peek");
    return sandbox;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logDaytonaBootstrap(
      sessionId,
      "sandbox",
      `${sandboxId} unavailable: ${detail.slice(0, 160)}`,
    );
    logDaytonaTiming(sessionId, "fetchSandbox.total", Date.now() - t0, `error=${detail.slice(0, 80)}`);
    return null;
  }
}

/** fetchSandbox with retries when wake=true. */
export async function reconnectSandbox(
  sessionId: string,
  sandboxId: string,
  wake: boolean,
): Promise<Sandbox | null> {
  const attempts = wake ? RECONNECT_ATTEMPTS : 1;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const sandbox = await fetchSandbox(sessionId, sandboxId, wake);
    if (sandbox) {
      return sandbox;
    }
    if (attempt < attempts) {
      await new Promise((r) => setTimeout(r, 1_000 * attempt));
    }
  }

  return null;
}

export async function createSandbox(session: Session): Promise<Sandbox> {
  const daytona = getDaytonaClient();
  const idleMinutes = Number(process.env.DAYTONA_SANDBOX_IDLE_MINUTES ?? 30);
  const snapshot = getDaytonaSnapshotName();

  const baseParams = {
    language: "typescript" as const,
    labels: { "baby-lovable-session": session.id },
    autoStopInterval: idleMinutes > 0 ? idleMinutes : 0,
    // Public port preview — iframe uses getPreviewLink URL (no signed token).
    public: true,
  };

  logDaytonaBootstrap(
    session.id,
    "sandbox",
    snapshot
      ? `create snapshot=${snapshot} (pnpm + node_modules prebaked)`
      : "create default image (runtime seed + install — set DAYTONA_SNAPSHOT)",
  );

  let sandbox: Sandbox;
  try {
    sandbox = await daytona.create(
      snapshot ? { ...baseParams, snapshot } : baseParams,
      { timeout: 180 },
    );
  } catch (error) {
    if (!snapshot) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    if (!allowDaytonaSnapshotFallback()) {
      throw new Error(
        `Daytona snapshot "${snapshot}" create failed: ${detail.slice(0, 300)}. ` +
          `Rebuild with \`npm run build:daytona-snapshot -- --force\`, or set ` +
          `DAYTONA_SNAPSHOT_FALLBACK=1 to boot a default image (slow path).`,
      );
    }
    logDaytonaBootstrap(
      session.id,
      "sandbox",
      `snapshot failed (${detail.slice(0, 160)}) — default image (FALLBACK)`,
    );
    sandbox = await daytona.create(baseParams, { timeout: 180 });
  }

  await sandbox.waitUntilStarted(180);
  if (!sandbox.public) {
    await ensureSandboxPublic(sandbox);
  }
  logDaytonaBootstrap(
    session.id,
    "sandbox",
    `started ${sandbox.id}${snapshot ? ` from snapshot=${snapshot}` : ""}`,
  );
  return sandbox;
}

export async function deleteSandboxById(
  sessionId: string,
  sandboxId: string,
): Promise<void> {
  logDaytonaBootstrap(sessionId, "sandbox", `delete ${sandboxId}`);
  try {
    const sandbox = await getDaytonaClient().get(sandboxId);
    await sandbox.delete(60);
  } catch {
    // already gone
  }
}
