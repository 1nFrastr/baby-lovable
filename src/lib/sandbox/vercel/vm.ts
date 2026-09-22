import { Sandbox } from "@vercel/sandbox";

import { resumeVercelPreview } from "./app-server-boot";
import { vercelAuthOptions } from "./client";
import {
  getVercelDevPort,
  getVercelIdleMs,
  getVercelNetworkPolicy,
  getVercelSandboxImage,
  getVercelSnapshotId,
  isVercelSandboxConfigured,
  vercelSandboxName,
} from "./config";
import { VercelProjectSandbox } from "./provider";

function logVercel(sessionId: string, phase: string, message: string): void {
  console.warn(`[vercel] session=${sessionId} ${phase} ${message}`);
}

function onResume(sessionId: string) {
  return async (sandbox: Sandbox) => {
    logVercel(sessionId, "sandbox", `onResume ${sandbox.name}`);
    await resumeVercelPreview(sessionId, sandbox);
  };
}

export function wrapVercelSandbox(
  sessionId: string,
  sandbox: Sandbox,
): VercelProjectSandbox {
  return new VercelProjectSandbox(sessionId, sandbox);
}

export async function createVercelSandbox(
  sessionId: string,
): Promise<Sandbox> {
  if (!isVercelSandboxConfigured()) {
    throw new Error(
      "Vercel Sandbox is not configured. Set VERCEL_TOKEN (or VERCEL_OIDC_TOKEN) and VERCEL_PROJECT_ID.",
    );
  }

  const name = vercelSandboxName(sessionId);
  const port = getVercelDevPort();
  const snapshotId = getVercelSnapshotId();
  const timeout = getVercelIdleMs();
  const auth = vercelAuthOptions();
  const networkPolicy = getVercelNetworkPolicy();
  const resume = onResume(sessionId);

  logVercel(
    sessionId,
    "sandbox",
    snapshotId
      ? `create name=${name} snapshot=${snapshotId}`
      : `create name=${name} image=${getVercelSandboxImage()}`,
  );

  const createParams = snapshotId
    ? {
        name,
        ports: [port],
        timeout,
        persistent: true as const,
        source: { type: "snapshot" as const, snapshotId },
        networkPolicy,
        onResume: resume,
        ...auth,
      }
    : {
        name,
        ports: [port],
        timeout,
        persistent: true as const,
        image: getVercelSandboxImage(),
        networkPolicy,
        onResume: resume,
        ...auth,
      };

  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.create(createParams);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logVercel(sessionId, "sandbox", `create failed, getOrCreate: ${detail.slice(0, 160)}`);
    sandbox = await Sandbox.getOrCreate({
      ...createParams,
      resume: true,
    });
  }

  logVercel(sessionId, "sandbox", `started ${sandbox.name} status=${sandbox.status}`);
  return sandbox;
}

export async function fetchVercelSandbox(
  sessionId: string,
  sandboxId: string,
  wake: boolean,
): Promise<Sandbox | null> {
  const auth = vercelAuthOptions();
  try {
    const sandbox = await Sandbox.get({
      name: sandboxId,
      resume: wake,
      onResume: onResume(sessionId),
      ...auth,
    });
    if (!wake && sandbox.status !== "running") {
      logVercel(sessionId, "sandbox", `${sandboxId} is ${sandbox.status}`);
      return null;
    }
    return sandbox;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logVercel(sessionId, "sandbox", `${sandboxId} unavailable: ${detail.slice(0, 160)}`);
    return null;
  }
}

export async function reconnectVercelSandbox(
  sessionId: string,
  sandboxId: string,
  wake: boolean,
): Promise<Sandbox | null> {
  const sandbox = await fetchVercelSandbox(sessionId, sandboxId, wake);
  if (sandbox && wake) {
    try {
      await sandbox.extendTimeout(getVercelIdleMs());
    } catch {
      // best effort — session may already be at plan max
    }
  }
  return sandbox;
}

export async function vercelSandboxExists(sandboxId: string): Promise<boolean> {
  try {
    await Sandbox.get({
      name: sandboxId,
      resume: false,
      ...vercelAuthOptions(),
    });
    return true;
  } catch {
    return false;
  }
}

export async function deleteVercelSandboxById(
  sessionId: string,
  sandboxId: string,
): Promise<void> {
  logVercel(sessionId, "sandbox", `delete ${sandboxId}`);
  try {
    const sandbox = await Sandbox.get({
      name: sandboxId,
      resume: false,
      ...vercelAuthOptions(),
    });
    await sandbox.delete();
  } catch {
    // already gone
  }
}
