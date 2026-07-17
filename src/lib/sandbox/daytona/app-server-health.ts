/** App-server health: probe preview URL, next logs, compile errors. */
import {
  readSignedPreviewStore,
  writeSignedPreviewStore,
} from "@/lib/session/signed-preview-store";
import type { Sandbox } from "@daytona/sdk";

import { isUnreliableCompileError } from "../preview-errors";
import { logDaytonaBootstrap } from "./bootstrap-log";
import { getDaytonaDevPort } from "./config";
import type { DaytonaProjectSandbox } from "./provider";
import { getExistingDaytonaSandbox } from "./sandbox";

const SIGNED_TTL_SEC = 3600;
/** Re-mint before expiry so iframe never hits a dead signed URL mid-session. */
const SIGNED_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 15_000;

const COMPILE_MARKERS = [
  /Parsing CSS source code failed/i,
  /Failed to compile/i,
  /Module not found/i,
  /⨯ \.\//,
  /Turbopack build failed/i,
  /Event handlers cannot be passed/i,
  /Client Component props/i,
  /You're importing a component that needs/i,
  /Server Actions must be async/i,
  /⨯ Error:/,
];

export async function remoteFileExists(
  sandbox: DaytonaProjectSandbox,
  path: string,
): Promise<boolean> {
  try {
    await sandbox.fs.getFileDetails(path);
    return true;
  } catch {
    return false;
  }
}

export async function readDevLog(sandbox: DaytonaProjectSandbox): Promise<string> {
  try {
    return await sandbox.fs.readTextFile(".next/dev/logs/next-development.log");
  } catch {
    return "";
  }
}

export function extractCompileError(content: string): string | null {
  const lines = content.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (!COMPILE_MARKERS.some((m) => m.test(line))) {
      continue;
    }
    const slice = lines.slice(Math.max(0, i - 2), i + 12).join("\n");
    if (!isUnreliableCompileError(slice)) {
      return slice.trim();
    }
  }
  return null;
}

/**
 * Stable iframe URL for a session. Reuses the same signed URL until near TTL
 * so localStorage / cookies keep working across checkPreview and page refresh.
 * Backed by session store (disk or Supabase) for serverless / Workflow isolates.
 */
export async function signedEmbedUrl(
  sessionId: string,
  sdk: Sandbox,
  port: number,
): Promise<string | undefined> {
  const now = Date.now();
  const cached = await readSignedPreviewStore(sessionId);
  if (
    cached &&
    cached.sandboxId === sdk.id &&
    cached.port === port &&
    cached.expiresAtMs - SIGNED_REFRESH_BUFFER_MS > now
  ) {
    return cached.url;
  }

  try {
    const signed = await sdk.getSignedPreviewUrl(port, SIGNED_TTL_SEC);
    await writeSignedPreviewStore(sessionId, {
      url: signed.url,
      sandboxId: sdk.id,
      port,
      expiresAtMs: now + SIGNED_TTL_SEC * 1000,
    });
    return signed.url;
  } catch {
    return undefined;
  }
}

export interface PreviewReady {
  url: string;
  port: number;
  probeUrl: string;
  token: string;
  sandbox: DaytonaProjectSandbox;
}

/** Peek running preview — never create or wake a stopped sandbox. */
export async function probePreview(
  sessionId: string,
): Promise<PreviewReady | null> {
  const run = async (): Promise<PreviewReady | null> => {
    const sandbox = await getExistingDaytonaSandbox(sessionId, { wake: false });
    if (!sandbox) {
      return null;
    }

    const sdk = sandbox.sdkSandbox;
    const port = getDaytonaDevPort();
    const preview = await sdk.getPreviewLink(port);
    const res = await fetch(preview.url, {
      headers: { "x-daytona-preview-token": preview.token },
      signal: AbortSignal.timeout(5_000),
    });

    if (res.status >= 600) {
      return null;
    }

    const embed = await signedEmbedUrl(sessionId, sdk, port);
    logDaytonaBootstrap(sessionId, "preview", `ready ${preview.url}`);
    return {
      url: embed ?? preview.url,
      port,
      probeUrl: preview.url,
      token: preview.token,
      sandbox,
    };
  };

  try {
    return await Promise.race([
      run(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), PROBE_TIMEOUT_MS)),
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logDaytonaBootstrap(sessionId, "preview", `probe failed: ${detail.slice(0, 160)}`);
    return null;
  }
}

export async function httpStatus(
  url: string,
  token?: string,
): Promise<number> {
  try {
    const res = await fetch(url, {
      headers: token ? { "x-daytona-preview-token": token } : undefined,
      signal: AbortSignal.timeout(5_000),
    });
    return res.status;
  } catch {
    return 503;
  }
}
