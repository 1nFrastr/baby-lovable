import { timingSafeEqual } from "node:crypto";

/**
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` when that env var is set.
 * Reject every caller when the secret is missing so the route is not public.
 */
export function isCronRequestAuthorized(
  authorization: string | null,
  secret: string | undefined,
): boolean {
  const expectedSecret = secret?.trim();
  if (!expectedSecret || !authorization) return false;

  const expected = `Bearer ${expectedSecret}`;
  const provided = Buffer.from(authorization);
  const required = Buffer.from(expected);
  if (provided.length !== required.length) return false;

  return timingSafeEqual(provided, required);
}
