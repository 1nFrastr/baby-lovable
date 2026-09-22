/** Default preview port for every sandbox provider. */
export function getDefaultDevPort(): number {
  const raw =
    process.env.SANDBOX_DEV_PORT ??
    process.env.VERCEL_DEV_PORT ??
    process.env.DAYTONA_DEV_PORT;
  const parsed = raw ? Number(raw) : 3000;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3000;
}

/** Idle stop / session-extend window in minutes (default 30). */
export function getSandboxIdleMinutes(): number {
  const raw =
    process.env.SANDBOX_IDLE_MINUTES ??
    process.env.VERCEL_SANDBOX_IDLE_MINUTES ??
    process.env.DAYTONA_SANDBOX_IDLE_MINUTES;
  const parsed = raw ? Number(raw) : 30;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30;
}
