/**
 * Vercel Sandbox is created with `persistent: false` — a stopped session cannot
 * be resumed. Treat stop / 410 / "no snapshot available" like Daytona
 * console-delete: confirmedAbsent, then recreate + Freestyle hydrate.
 */

const GONE_STATUSES = new Set(["stopped", "stopping", "failed"]);

export function isVercelSandboxLiveStatus(
  status: string | undefined | null,
): boolean {
  return status === "running" || status === "pending";
}

export function isVercelSandboxGoneStatus(
  status: string | undefined | null,
): boolean {
  return Boolean(status && GONE_STATUSES.has(status));
}

export function isVercelSandboxGoneError(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error);
  const text = raw.toLowerCase();
  return (
    text.includes("sandbox_stopped") ||
    text.includes("sandbox was stopped") ||
    text.includes("no longer reachable") ||
    text.includes("no snapshot available") ||
    text.includes("cannot resume sandbox") ||
    (text.includes("410") && text.includes("sandbox")) ||
    text.includes("sandbox_not_found") ||
    /sandbox.*not found/i.test(raw)
  );
}

/** Preview proxy returns this when the VM session is gone. */
export function isVercelSandboxGoneHttp(http: number): boolean {
  return http === 410;
}

export function describeVercelSandboxGone(
  detail?: string | null,
): string {
  const suffix = detail?.trim() ? ` (${detail.trim().slice(0, 160)})` : "";
  return `Vercel sandbox stopped or deleted externally${suffix}`;
}
