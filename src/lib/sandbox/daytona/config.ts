/** Daytona workspace filesystem — fast POSIX, safe for pnpm / .next / git. */
import { isDaytonaFreePlan } from "@/lib/features/durable-source-of-truth";

export const DAYTONA_WORKSPACE_ROOT =
  process.env.DAYTONA_WORKSPACE_ROOT ?? "/home/daytona/workspace";

export function getDaytonaDevPort(): number {
  const raw = process.env.DAYTONA_DEV_PORT;
  const parsed = raw ? Number(raw) : 3000;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3000;
}

export function getDaytonaIdleMinutes(): number {
  const raw = process.env.DAYTONA_SANDBOX_IDLE_MINUTES;
  const parsed = raw ? Number(raw) : 30;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30;
}

/**
 * Prebuilt snapshot with starter + pnpm + node_modules + warmed `.next/dev`.
 * Empty string disables snapshot (seed sources only — no runtime dep install).
 * Build with: `npm run build:daytona-snapshot -- --force`
 * Default resources at build time: 1 vCPU / 2 GiB / 3 GiB.
 */
export const DAYTONA_DEFAULT_SNAPSHOT = "baby-lovable-nextjs-starter-2g-warm2";

export function getDaytonaSnapshotName(): string | null {
  if (process.env.DAYTONA_SNAPSHOT === "") {
    return null;
  }
  const name = process.env.DAYTONA_SNAPSHOT?.trim() || DAYTONA_DEFAULT_SNAPSHOT;
  return name || null;
}

/**
 * When a snapshot name is configured but `daytona.create({ snapshot })` fails,
 * default is fail-hard (empty image has no baked deps; runtime no longer installs).
 * Set `DAYTONA_SNAPSHOT_FALLBACK=1` to boot a default image anyway.
 */
export function allowDaytonaSnapshotFallback(): boolean {
  const raw = process.env.DAYTONA_SNAPSHOT_FALLBACK?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Sandbox-level domain allow list for Freestyle / npm / GitHub.
 *
 * Tier 1–2 orgs reject `domainAllowList` on create — omit it on free plan and
 * rely on Daytona's default essential-services policy instead.
 * Pro (SoT) still needs Freestyle hosts explicitly allow-listed on Tier 3+.
 *
 * @returns undefined when the field must be omitted from `daytona.create`.
 */
export function getDaytonaDomainAllowList(): string | undefined {
  if (isDaytonaFreePlan()) {
    return undefined;
  }
  const fromEnv = process.env.DAYTONA_DOMAIN_ALLOW_LIST?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return [
    "git.freestyle.sh",
    "api.freestyle.sh",
    "*.freestyle.sh",
    "github.com",
    "*.github.com",
    "*.githubusercontent.com",
    "registry.npmjs.org",
    "registry.npmjs.com",
    "nodejs.org",
  ].join(",");
}

export function isDaytonaConfigured(): boolean {
  return Boolean(process.env.DAYTONA_API_KEY || process.env.DAYTONA_JWT_TOKEN);
}
