import type { SandboxMode } from "@/lib/sandbox/types";

/**
 * Daytona-only free-tier stand-in. Vercel sessions ignore this flag:
 * Vercel Sandbox supports a custom network allowlist (Freestyle / npm / GitHub),
 * so they always use Freestyle as the durable source of truth.
 *
 * DAYTONA_FREE_PLAN=1|true|on → ephemeral Daytona only
 *   (no Freestyle provision / checkpoint / GitHub Sync / History / Export)
 * unset or 0|false|off → pro behavior (Freestyle SoT required)
 *
 * Pass the session's `sandboxMode` at every session-scoped gate. Omitting
 * `mode` is only for Daytona-specific env (e.g. omitting `domainAllowList`).
 */
export function isDaytonaFreePlan(mode?: SandboxMode): boolean {
  if (mode === "vercel") {
    return false;
  }
  const raw = process.env.DAYTONA_FREE_PLAN?.trim().toLowerCase();
  if (!raw) {
    return false;
  }
  if (raw === "1" || raw === "true" || raw === "on" || raw === "yes") {
    return true;
  }
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") {
    return false;
  }
  return false;
}
