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
 * Whether to write screenshots / report.json / latest-status to disk.
 *
 * These are for local CLI/debug (`npm run test:app-preview`). Agent
 * `testPreview` only needs the in-memory report; on Vercel the deploy FS is
 * read-only and `/tmp` is not shared across invocations, so disk artifacts
 * are useless there.
 *
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
  return !(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}
