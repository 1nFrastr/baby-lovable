/** Progress logs for Daytona cold-start — visible in CLI stdout and web dev logs. */
export function logDaytonaBootstrap(
  sessionId: string,
  phase: string,
  message: string,
): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.warn(
    `[${ts}] BOOT      [daytona] session=${sessionId} ${phase}: ${message}`,
  );
}
