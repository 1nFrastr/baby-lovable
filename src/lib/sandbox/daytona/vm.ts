/** Daytona VM: get / wake / create / delete (SDK only — no session persistence). */
import type { Session } from "@/lib/session/types";

import { getDaytonaSnapshotName } from "./config";
import { getDaytonaClient } from "./client";
import { logDaytonaBootstrap } from "./bootstrap-log";
import { DaytonaProjectSandbox } from "./provider";
import type { Sandbox } from "@daytona/sdk";

const RECONNECT_ATTEMPTS = 3;

export function isAsleep(state: string | undefined): boolean {
  return state === "stopped" || state === "archived";
}

export function wrapSandbox(
  sessionId: string,
  sandbox: Sandbox,
): DaytonaProjectSandbox {
  return new DaytonaProjectSandbox(sessionId, sandbox);
}

/** Get sandbox by id. wake=false never starts stopped/archived VMs. */
export async function fetchSandbox(
  sessionId: string,
  sandboxId: string,
  wake: boolean,
): Promise<Sandbox | null> {
  const daytona = getDaytonaClient();
  logDaytonaBootstrap(
    sessionId,
    "sandbox",
    wake ? `reconnect ${sandboxId}` : `peek ${sandboxId}`,
  );

  try {
    const sandbox = await daytona.get(sandboxId);

    if (isAsleep(sandbox.state)) {
      if (!wake) {
        logDaytonaBootstrap(sessionId, "sandbox", `${sandboxId} is ${sandbox.state}`);
        return null;
      }
      await sandbox.start(120);
    }

    await sandbox.waitUntilStarted(120);
    return sandbox;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logDaytonaBootstrap(
      sessionId,
      "sandbox",
      `${sandboxId} unavailable: ${detail.slice(0, 160)}`,
    );
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
  };

  logDaytonaBootstrap(
    session.id,
    "sandbox",
    snapshot ? `create snapshot=${snapshot}` : "create default image",
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
    logDaytonaBootstrap(
      session.id,
      "sandbox",
      `snapshot failed (${detail.slice(0, 160)}) — default image`,
    );
    sandbox = await daytona.create(baseParams, { timeout: 180 });
  }

  await sandbox.waitUntilStarted(180);
  logDaytonaBootstrap(session.id, "sandbox", `started ${sandbox.id}`);
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
