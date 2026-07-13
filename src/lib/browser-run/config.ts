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
