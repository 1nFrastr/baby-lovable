/**
 * On-demand platform logs for the builder agent (`readLog` tool).
 * Each source is a fixed, allowlisted stream — not arbitrary shell or paths.
 */

import { getExistingDaytonaSandbox } from "./daytona/sandbox";
import { readDevLogLines } from "./daytona/app-server-health";

export const READ_LOG_SOURCES = ["preview"] as const;
export type ReadLogSource = (typeof READ_LOG_SOURCES)[number];

export const READ_LOG_DEFAULT_LINES = 20;
export const READ_LOG_MAX_LINES = 100;

export function isReadLogSource(value: string): value is ReadLogSource {
  return (READ_LOG_SOURCES as readonly string[]).includes(value);
}

export type ReadLogResult = {
  ok: boolean;
  source: string;
  lines: number;
  text: string;
  error?: string;
};

/**
 * Read the latest N lines from a named log source for the session sandbox.
 */
export async function readSessionLog(
  sessionId: string,
  source: string,
  lines: number = READ_LOG_DEFAULT_LINES,
): Promise<ReadLogResult> {
  const capped = Math.min(
    READ_LOG_MAX_LINES,
    Math.max(1, Math.floor(lines || READ_LOG_DEFAULT_LINES)),
  );

  if (!isReadLogSource(source)) {
    return {
      ok: false,
      source,
      lines: capped,
      text: "",
      error: `Unsupported log source "${source}". Supported: ${READ_LOG_SOURCES.join(", ")}.`,
    };
  }

  const sandbox = await getExistingDaytonaSandbox(sessionId, { wake: false });
  if (!sandbox) {
    return {
      ok: false,
      source,
      lines: capped,
      text: "",
      error: "Preview sandbox is not available yet.",
    };
  }

  if (source === "preview") {
    const text = await readDevLogLines(sandbox, capped);
    return {
      ok: true,
      source,
      lines: capped,
      text,
      ...(text
        ? {}
        : {
            error:
              "No preview log yet (Next may still be starting or the log file is empty).",
          }),
    };
  }

  return {
    ok: false,
    source,
    lines: capped,
    text: "",
    error: `Unsupported log source "${source}".`,
  };
}
