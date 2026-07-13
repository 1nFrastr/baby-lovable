/** Local sandbox filesystem — fast POSIX, safe for pnpm / .next / git. */
export const DAYTONA_WORKSPACE_ROOT =
  process.env.DAYTONA_WORKSPACE_ROOT ?? "/home/daytona/workspace";

/**
 * FUSE volume mount — durable source-of-truth for project files (S3-backed).
 * Synced via SDK uploadFiles/downloadFiles after each agent turn; never run
 * pnpm / next dev directly on this path.
 * @see https://www.daytona.io/docs/en/volumes#limitations
 */
export const DAYTONA_VOLUME_MOUNT =
  process.env.DAYTONA_VOLUME_MOUNT ?? "/home/daytona/persist";

export function getDaytonaDevPort(): number {
  const raw = process.env.DAYTONA_DEV_PORT;
  const parsed = raw ? Number(raw) : 3000;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3000;
}

export function getDaytonaVolumeName(): string {
  return process.env.DAYTONA_VOLUME_NAME ?? "baby-lovable-workspaces";
}

export function getDaytonaIdleMinutes(): number {
  const raw = process.env.DAYTONA_SANDBOX_IDLE_MINUTES;
  const parsed = raw ? Number(raw) : 30;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30;
}

export function isDaytonaConfigured(): boolean {
  return Boolean(process.env.DAYTONA_API_KEY || process.env.DAYTONA_JWT_TOKEN);
}
