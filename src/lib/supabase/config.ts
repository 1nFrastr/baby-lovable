/**
 * Supabase env vars synced by the Vercel Marketplace integration.
 * @see https://supabase.com/docs/guides/integrations/vercel-marketplace
 *
 * NEXT_PUBLIC_* must use static `process.env.NEXT_PUBLIC_…` access so Next.js
 * can inline them into client bundles. Dynamic `process.env[name]` only works
 * server-side.
 */

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value && value.length > 0) return value;
  }
  return undefined;
}

/** Public Supabase project URL (Vercel syncs `NEXT_PUBLIC_SUPABASE_URL`). */
export function getSupabaseUrl(): string | undefined {
  return firstNonEmpty(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_URL,
  );
}

/**
 * Publishable (anon) key — Vercel Marketplace uses the new naming convention;
 * fall back to legacy `*_ANON_KEY` for projects created before the rename.
 */
export function getSupabasePublishableKey(): string | undefined {
  return firstNonEmpty(
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    process.env.SUPABASE_PUBLISHABLE_KEY,
    process.env.SUPABASE_ANON_KEY,
  );
}

/** Secret (service-role) key for trusted server-side operations. */
export function getSupabaseSecretKey(): string | undefined {
  return firstNonEmpty(
    process.env.SUPABASE_SECRET_KEY,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}

/**
 * Headless user id for CLI / workflow when no browser cookie is present.
 * Set to a real `auth.users.id` from your Supabase project for local CLI testing.
 */
export function getDevUserId(): string | undefined {
  return firstNonEmpty(process.env.BABY_LOVABLE_DEV_USER_ID);
}

/** True when both URL and publishable key are present. */
export function isSupabaseConfigured(): boolean {
  return Boolean(getSupabaseUrl() && getSupabasePublishableKey());
}

/** True when the secret key is available for admin / workflow operations. */
export function isSupabaseAdminConfigured(): boolean {
  return Boolean(getSupabaseUrl() && getSupabaseSecretKey());
}
