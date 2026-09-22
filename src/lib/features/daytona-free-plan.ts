/**
 * Global free-tier stand-in for Daytona sessions.
 *
 * DAYTONA_FREE_PLAN=1|true|on → ephemeral Daytona only
 *   (no Freestyle provision / checkpoint / GitHub Sync / History / Export)
 * unset or 0|false|off → pro behavior (Freestyle SoT required)
 */
export function isDaytonaFreePlan(): boolean {
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
