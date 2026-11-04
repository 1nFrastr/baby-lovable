/** Supabase REST administration using host-only credentials obtained from Connect. */

export interface SupabaseManagementProject {
  id: string;
  ref: string;
  name: string;
  organizationId: string;
  region: string;
  status: string;
}

export interface SupabaseApiKeyRow {
  name: string;
  api_key: string;
}

const MANAGEMENT_API_BASE = "https://api.supabase.com/v1";
const REQUEST_TIMEOUT_MS = 30_000;

/** Provider errors never include credentials, submitted SQL, or function source. */
export class SupabaseManagementError extends Error {
  constructor(message: string, public readonly status: number | null = null) {
    super(message);
    this.name = "SupabaseManagementError";
  }
}

export interface SupabaseManagementRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: BodyInit | Record<string, unknown> | unknown[] | null;
  headers?: HeadersInit;
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
  operation: string,
): Promise<T> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
      cache: "no-store",
    });
    if (!response.ok) {
      // Management API errors can echo submitted SQL, secrets, or source.
      // Keep status for callers, without propagating an untrusted response body.
      throw new SupabaseManagementError(
        `${operation} failed (${response.status})`,
        response.status,
      );
    }
    if (response.status === 204) {
      return undefined as T;
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new SupabaseManagementError(`${operation} returned invalid JSON`);
    }
  } catch (error) {
    if (error instanceof SupabaseManagementError) {
      throw error;
    }
    // Fetch errors may contain URLs, authorization details, or request bodies.
    throw new SupabaseManagementError(`${operation} could not be completed`);
  }
}

/**
 * Host-only Management API request. JSON objects and multipart FormData are
 * supported. Requests are bounded and never retried: a timed-out migration or
 * deployment may have succeeded remotely and must be reconciled by the caller.
 */
export async function supabaseManagementRequest<T>(
  accessToken: string,
  path: string,
  options: SupabaseManagementRequestOptions = {},
): Promise<T> {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[\\#\s]/.test(path) ||
    path.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new SupabaseManagementError("Invalid Management API path");
  }
  const url = new URL(`${MANAGEMENT_API_BASE}${path}`);
  if (
    url.origin !== "https://api.supabase.com" ||
    !url.pathname.startsWith("/v1/")
  ) {
    throw new SupabaseManagementError("Invalid Management API path");
  }
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.set("Accept", "application/json");
  let body: BodyInit | null | undefined = options.body as BodyInit | null | undefined;
  if (
    options.body != null &&
    (Array.isArray(options.body) ||
      Object.getPrototypeOf(options.body) === Object.prototype)
  ) {
    body = JSON.stringify(options.body);
    headers.set("Content-Type", "application/json");
  } else if (options.body instanceof FormData) {
    // Fetch must choose the boundary matching the encoded multipart body.
    headers.delete("Content-Type");
  }
  return requestJson<T>(
    url.toString(),
    { method: options.method ?? "GET", headers, body },
    "Supabase Management API request",
  );
}

export async function listSupabaseProjects(
  accessToken: string,
): Promise<SupabaseManagementProject[]> {
  const data = await supabaseManagementRequest<
    Array<{
      id: string;
      ref?: string;
      name: string;
      organization_id: string;
      region: string;
      status: string;
    }>
  >(accessToken, "/projects");
  return (Array.isArray(data) ? data : []).map((p) => ({
    id: p.id,
    ref: p.ref || p.id,
    name: p.name,
    organizationId: p.organization_id,
    region: p.region,
    status: p.status,
  }));
}

export async function getSupabaseProjectApiKeys(
  accessToken: string,
  projectRef: string,
): Promise<{ anonKey: string; serviceRoleKey: string }> {
  const keys = await supabaseManagementRequest<SupabaseApiKeyRow[]>(
    accessToken,
    `/projects/${encodeURIComponent(projectRef)}/api-keys?reveal=true`,
  );
  const list = Array.isArray(keys) ? keys : [];
  const anon = list.find((k) => k.api_key?.startsWith("sb_publishable_"))?.api_key ??
    list.find((k) => k.name === "anon")?.api_key;
  const usable = (key: string | undefined) => Boolean(key && !/[·*\s]/u.test(key));
  const service = list.find((k) => k.api_key?.startsWith("sb_secret_") && usable(k.api_key))?.api_key ??
    list.find((k) => k.name === "service_role" && usable(k.api_key))?.api_key;
  if (!anon || !service) {
    throw new Error(
      "Could not read anon/service_role API keys for this project",
    );
  }
  return { anonKey: anon, serviceRoleKey: service };
}

export function supabaseProjectUrl(projectRef: string): string {
  return `https://${projectRef}.supabase.co`;
}
