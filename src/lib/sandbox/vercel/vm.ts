import { Sandbox } from "@vercel/sandbox";

import { resumeVercelPreview } from "./app-server-boot";
import { vercelAuthOptions } from "./client";
import {
  getVercelDevPort,
  getVercelIdleMs,
  getVercelNetworkPolicy,
  getVercelResources,
  getVercelSandboxImage,
  getVercelSnapshotId,
  isVercelSandboxConfigured,
  vercelSandboxName,
} from "./config";
import {
  describeVercelSandboxGone,
  isVercelSandboxGoneError,
  isVercelSandboxLiveStatus,
} from "./errors";
import { VercelProjectSandbox } from "./provider";
import { ensureVercelWorkspaceRoot } from "./workspace-root";

function logVercel(sessionId: string, phase: string, message: string): void {
  console.warn(`[vercel] session=${sessionId} ${phase} ${message}`);
}

function onResume(sessionId: string) {
  return async (sandbox: Sandbox) => {
    logVercel(sessionId, "sandbox", `onResume ${sandbox.name}`);
    await ensureVercelWorkspaceRoot(sandbox);
    await resumeVercelPreview(sessionId, sandbox);
  };
}

export function wrapVercelSandbox(
  sessionId: string,
  sandbox: Sandbox,
): VercelProjectSandbox {
  return new VercelProjectSandbox(sessionId, sandbox);
}

export type VercelSandboxPeek =
  | { state: "live"; sandbox: Sandbox; status: string }
  | { state: "gone"; reason: string; status: string | null }
  | { state: "unknown"; reason: string };

/**
 * Classify a stored Vercel sandbox id without resuming it.
 * `persistent: false` — stopped / 410 is gone, not Daytona-style asleep.
 */
export async function peekVercelSandbox(
  sandboxId: string,
): Promise<VercelSandboxPeek> {
  try {
    const sandbox = await Sandbox.get({
      name: sandboxId,
      resume: false,
      ...vercelAuthOptions(),
    });
    const status = sandbox.status ?? "unknown";
    if (isVercelSandboxLiveStatus(status)) {
      return { state: "live", sandbox, status };
    }
    return {
      state: "gone",
      reason: describeVercelSandboxGone(status),
      status,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (isVercelSandboxGoneError(error)) {
      return {
        state: "gone",
        reason: describeVercelSandboxGone(detail),
        status: null,
      };
    }
    return { state: "unknown", reason: detail.slice(0, 200) };
  }
}

type VercelCreateParams = NonNullable<Parameters<typeof Sandbox.create>[0]>;

function vercelCreateParams(
  sessionId: string,
  name: string,
): VercelCreateParams {
  const snapshotId = getVercelSnapshotId();
  const auth = vercelAuthOptions();
  const shared = {
    name,
    ports: [getVercelDevPort()],
    timeout: getVercelIdleMs(),
    persistent: false as const,
    resources: getVercelResources(),
    networkPolicy: getVercelNetworkPolicy(),
    onResume: onResume(sessionId),
    ...auth,
  };
  if (snapshotId) {
    return {
      ...shared,
      source: { type: "snapshot" as const, snapshotId },
    };
  }
  return {
    ...shared,
    image: getVercelSandboxImage(),
  };
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
  const params = vercelCreateParams(sessionId, name);
  const snapshotId = getVercelSnapshotId();
  logVercel(
    sessionId,
    "sandbox",
    snapshotId
      ? `create name=${name} snapshot=${snapshotId} vcpus=${getVercelResources().vcpus} timeoutMs=${getVercelIdleMs()}`
      : `create name=${name} image=${getVercelSandboxImage()} vcpus=${getVercelResources().vcpus} timeoutMs=${getVercelIdleMs()}`,
  );

  const sandbox = await createVercelSandboxWithReuse(sessionId, name, params);
  logVercel(
    sessionId,
    "sandbox",
    `started ${sandbox.name} status=${sandbox.status}`,
  );
  await ensureVercelWorkspaceRoot(sandbox);
  return sandbox;
}

async function createVercelSandboxWithReuse(
  sessionId: string,
  name: string,
  params: VercelCreateParams,
): Promise<Sandbox> {
  try {
    return await Sandbox.create(params);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logVercel(
      sessionId,
      "sandbox",
      `create failed: ${detail.slice(0, 160)}`,
    );

    // persistent: false cannot resume. Reuse only a still-running VM;
    // a stopped name (no snapshot / SANDBOX_STOPPED) is replaced and
    // Freestyle hydrate runs after create, same as Daytona console-delete.
    const peeked = await peekVercelSandbox(name);
    if (peeked.state === "live") {
      logVercel(sessionId, "sandbox", `create raced — reuse live ${name}`);
      return peeked.sandbox;
    }
    if (peeked.state === "gone" || isVercelSandboxGoneError(error)) {
      return createVercelSandboxReplacingGone(sessionId, name, params);
    }
    throw error;
  }
}

async function createVercelSandboxReplacingGone(
  sessionId: string,
  name: string,
  params: VercelCreateParams,
): Promise<Sandbox> {
  logVercel(sessionId, "sandbox", `replace stopped name=${name}`);
  await deleteVercelSandboxById(sessionId, name);
  try {
    return await Sandbox.create(params);
  } catch {
    const unique = vercelSandboxName(sessionId, Date.now().toString(36));
    logVercel(
      sessionId,
      "sandbox",
      `name still claimed — create unique=${unique}`,
    );
    return Sandbox.create({
      ...params,
      name: unique,
    });
  }
}

export async function fetchVercelSandbox(
  sessionId: string,
  sandboxId: string,
  wake: boolean,
): Promise<Sandbox | null> {
  const peeked = await peekVercelSandbox(sandboxId);
  if (peeked.state === "gone") {
    logVercel(
      sessionId,
      "sandbox",
      `${sandboxId} gone: ${peeked.reason.slice(0, 160)}`,
    );
    return null;
  }
  if (peeked.state === "unknown") {
    logVercel(
      sessionId,
      "sandbox",
      `${sandboxId} unavailable: ${peeked.reason.slice(0, 160)}`,
    );
    return null;
  }
  if (wake) {
    await ensureVercelWorkspaceRoot(peeked.sandbox);
  }
  return peeked.sandbox;
}

export async function reconnectVercelSandbox(
  sessionId: string,
  sandboxId: string,
  wake: boolean,
): Promise<Sandbox | null> {
  return fetchVercelSandbox(sessionId, sandboxId, wake);
}

/** True unless the provider confirmed the VM is gone. Transient get failures stay true. */
export async function vercelSandboxExists(sandboxId: string): Promise<boolean> {
  const peeked = await peekVercelSandbox(sandboxId);
  return peeked.state !== "gone";
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
