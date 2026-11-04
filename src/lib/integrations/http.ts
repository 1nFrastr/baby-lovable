export class IntegrationProviderError extends Error {
  constructor(readonly provider: string, readonly status: number) {
    super(`${provider} could not complete this request (${status}). Check your connection and permissions, then try again.`);
    this.name = "IntegrationProviderError";
  }
}

/** Never expose provider response bodies: they can contain credentials or app data. */
export async function integrationFetch(
  provider: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new IntegrationProviderError(provider, 504);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new IntegrationProviderError(provider, response.status);
  }
  return response;
}

export function supabaseHeaders(publicKey: string, serverKey?: string): Record<string, string> {
  return {
    apikey: serverKey || publicKey,
    // New sb_secret_ keys authenticate through apikey, not a JWT bearer.
    ...(serverKey && !serverKey.startsWith("sb_secret_")
      ? { Authorization: `Bearer ${serverKey}` }
      : {}),
  };
}
