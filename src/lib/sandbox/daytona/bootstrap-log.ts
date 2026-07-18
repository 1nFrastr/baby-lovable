/** Progress logs for Daytona cold-start — visible in CLI stdout and web dev logs. */
export function logDaytonaBootstrap(
  sessionId: string,
  phase: string,
  message: string,
  meta?: { generation?: number; leaseOwner?: string | null },
): void {
  const ts = new Date().toISOString().slice(11, 23);
  const extras: string[] = [];
  if (meta?.generation != null) {
    extras.push(`gen=${meta.generation}`);
  }
  if (meta?.leaseOwner) {
    extras.push(`lease=${meta.leaseOwner.slice(0, 8)}`);
  }
  const suffix = extras.length > 0 ? ` ${extras.join(" ")}` : "";
  console.warn(
    `[${ts}] BOOT      [daytona] session=${sessionId} ${phase}: ${message}${suffix}`,
  );
}
