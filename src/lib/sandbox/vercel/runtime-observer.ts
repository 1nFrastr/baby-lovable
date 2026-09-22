import {
  PREVIEW_HTTP_TIMEOUT_MS,
} from "../daytona/app-server-health";
import type { ObservedRuntime } from "../daytona/runtime-observer";
import type { DaytonaRuntimeSnapshot } from "../daytona/runtime-state";
import { getRuntimeSnapshot } from "../daytona/runtime-store";
import { getVercelDevPort } from "./config";
import {
  describeVercelSandboxGone,
  isVercelSandboxGoneHttp,
} from "./errors";
import { peekVercelSandbox, wrapVercelSandbox } from "./vm";

function emptyObserved(
  lastError: string | null = null,
  transient = false,
): ObservedRuntime {
  return {
    phase: "missing",
    sandboxId: null,
    sandboxState: null,
    previewUrl: null,
    previewPort: null,
    probeUrl: null,
    httpStatus: null,
    lastError,
    transient,
  };
}

async function probeUrl(url: string): Promise<{
  ready: boolean;
  http: number | null;
  lastError: string | null;
  transient: boolean;
}> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(PREVIEW_HTTP_TIMEOUT_MS),
    });
    const http = res.status;
    await res.body?.cancel().catch(() => {});
    if ((http >= 200 && http < 400) || http === 500) {
      return { ready: true, http, lastError: null, transient: false };
    }
    if (http >= 500) {
      return { ready: false, http, lastError: null, transient: false };
    }
    return {
      ready: false,
      http,
      lastError: `Preview returned HTTP ${http}`,
      transient: false,
    };
  } catch {
    return {
      ready: false,
      http: null,
      lastError: "preview probe failed",
      transient: true,
    };
  }
}

export async function observeVercelRuntime(
  sessionId: string,
  options?: { wake?: boolean; snapshot?: DaytonaRuntimeSnapshot },
): Promise<ObservedRuntime> {
  const snapshot =
    options?.snapshot ??
    (await getRuntimeSnapshot(sessionId, null, { fresh: true }));

  if (!snapshot.sandboxId) {
    return emptyObserved();
  }

  const peeked = await peekVercelSandbox(snapshot.sandboxId);
  if (peeked.state === "gone") {
    return {
      ...emptyObserved(peeked.reason),
      confirmedAbsent: true,
    };
  }
  if (peeked.state === "unknown") {
    return {
      ...emptyObserved(peeked.reason, true),
      phase: "workspace-ready",
      sandboxId: snapshot.sandboxId,
    };
  }

  const sdk = peeked.sandbox;
  const project = wrapVercelSandbox(sessionId, sdk);
  const port = snapshot.previewPort ?? getVercelDevPort();
  let url = snapshot.previewUrl;
  try {
    url = project.sdkSandbox.domain(port);
  } catch {
    // port may not have been registered
  }

  if (!url) {
    return {
      phase: "workspace-ready",
      sandboxId: sdk.name,
      sandboxState: sdk.status ?? null,
      previewUrl: null,
      previewPort: port,
      probeUrl: null,
      httpStatus: null,
      lastError: "preview domain not registered",
      transient: true,
    };
  }

  const probe = await probeUrl(url);
  if (probe.http != null && isVercelSandboxGoneHttp(probe.http)) {
    return {
      ...emptyObserved(describeVercelSandboxGone(`HTTP ${probe.http}`)),
      httpStatus: probe.http,
      confirmedAbsent: true,
    };
  }
  if (probe.ready) {
    return {
      phase: "preview-ready",
      sandboxId: sdk.name,
      sandboxState: sdk.status ?? null,
      previewUrl: url,
      previewPort: port,
      probeUrl: url,
      httpStatus: probe.http,
      lastError: null,
    };
  }

  return {
    ...emptyObserved(),
    phase: "workspace-ready",
    sandboxId: sdk.name,
    sandboxState: sdk.status ?? null,
    previewUrl: url,
    previewPort: port,
    probeUrl: url,
    httpStatus: probe.http,
    lastError: probe.lastError,
    transient: probe.transient,
  };
}
