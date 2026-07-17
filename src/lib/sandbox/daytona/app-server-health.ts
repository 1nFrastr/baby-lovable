/** App-server health: probe preview URL, next logs, compile errors. */
import { isUnreliableCompileError } from "../preview-errors";
import { logDaytonaBootstrap } from "./bootstrap-log";
import { getDaytonaDevPort } from "./config";
import { getExistingDaytonaSandbox } from "./sandbox";
import type { DaytonaProjectSandbox } from "./provider";
import type { Sandbox } from "@daytona/sdk";

const SIGNED_TTL_SEC = 3600;
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

export async function signedEmbedUrl(
  sdk: Sandbox,
  port: number,
): Promise<string | undefined> {
  try {
    return (await sdk.getSignedPreviewUrl(port, SIGNED_TTL_SEC)).url;
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

    const embed = await signedEmbedUrl(sdk, port);
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
