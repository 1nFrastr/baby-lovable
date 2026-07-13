export interface BrowserRunConfig {
  accountId: string;
  apiToken: string;
}

export function getBrowserRunConfig(): BrowserRunConfig | null {
  const accountId =
    process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ||
    process.env.CF_ACCOUNT_ID?.trim();
  const apiToken =
    process.env.CLOUDFLARE_BROWSER_RUN_API_TOKEN?.trim() ||
    process.env.CF_API_TOKEN?.trim() ||
    process.env.CLOUDFLARE_API_TOKEN?.trim();

  if (!accountId || !apiToken) {
    return null;
  }

  return { accountId, apiToken };
}

export function requireBrowserRunConfig(): BrowserRunConfig {
  const config = getBrowserRunConfig();
  if (!config) {
    throw new Error(
      "Cloudflare Browser Run is not configured. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_BROWSER_RUN_API_TOKEN (Browser Rendering - Edit).",
    );
  }
  return config;
}

export function browserRunConfigured(): boolean {
  return getBrowserRunConfig() !== null;
}

/**
 * Whether to write screenshots / report.json / monitor.html to disk.
 * Local CLI debugging only. Live View PiP uses durable store
 * (session file / Supabase `session_app_test_status`).
 *
 * Do NOT key off bare `VERCEL=1`: `vercel env pull` sets that in `.env.local`.
 * Override: `BABY_LOVABLE_APP_TEST_ARTIFACTS=0|1`
 */
export function shouldPersistAppTestArtifacts(): boolean {
  const raw = process.env.BABY_LOVABLE_APP_TEST_ARTIFACTS?.trim();
  if (raw === "0" || raw === "false") {
    return false;
  }
  if (raw === "1" || raw === "true") {
    return true;
  }
  return !(
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.cwd() === "/var/task"
  );
}

function envFlagEnabled(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * @deprecated Status is always durable-store-only now (local ≡ prod).
 * Kept so old `.env.local` flags do not break; value is ignored.
 */
export function simulateServerlessMemoryLoss(): boolean {
  return true;
}

/** Opt-in artificial delay before durable status write (ms). Default 0. */
export function appTestStatusWriteDelayMs(): number {
  const raw = process.env.BABY_LOVABLE_APP_TEST_STATUS_WRITE_DELAY_MS?.trim();
  if (!raw) {
    return 0;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 30_000) : 0;
}

/**
 * Local-only: drop in-memory Daytona preview state before each status resolve,
 * so the poller re-discovers preview like a cold Vercel isolate.
 * Separate from volume/persistence bugs — does not recreate the sandbox.
 */
export function simulatePreviewColdIsolate(): boolean {
  return envFlagEnabled("BABY_LOVABLE_SIMULATE_PREVIEW_COLD");
}
