// The preview runs in an HTTPS iframe on a different site from the builder.
// Use the same options for every Supabase client that writes auth cookies.
export const supabaseCookieOptions =
  process.env.NODE_ENV === "development" &&
  process.env.NEXT_PUBLIC_BABY_LOVABLE_EMBEDDED_PREVIEW === "1"
    ? { sameSite: "none" as const, secure: true, partitioned: true, path: "/" }
    : undefined;
