---
name: supabase
description: Build Auth, Postgres, Storage, RLS, and Edge Functions in the generated app using the linked Supabase project and the host backend tool. Use when the app needs login, persistent data, file uploads, or server functions.
---

# Supabase (generated app)

## Connection and credentials

Call `backend` with action `status` first. The host injects `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and server-only `SUPABASE_SERVICE_ROLE_KEY` into preview and published app environments. Never read, print, copy, or commit their values. Never use the host app's own Supabase project for the generated app.

If disconnected, direct the user to **Backend → Supabase** to create and link a dedicated project in their organization or select an existing project. Management actions require the app owner's Vercel Connect authorization for Supabase; a manual URL/key link alone supports app runtime access. The host manages provider authorization and refresh; do not implement this authorization inside the generated app. If management access is missing or revoked, explain the reconnect step and retain the generated implementation for when they connect.

Use the host `backend` tool for project administration. Do not request Management API tokens, run remote Supabase CLI commands, or send SQL through sandbox shell scripts. Never change a different project or erase existing data to make a demo work.

## Packages and source files

```bash
pnpm add @supabase/supabase-js @supabase/ssr
```

Use the source file tools for application code. Keep reviewable migration snapshots as `.sql` files in `src/backend/migrations/` and bundled function snapshots as `.txt` files in `src/backend/functions/`, then supply their SQL/source to `backend`. The `.txt` extension keeps Deno-only function code out of Next.js TypeScript checks. The workspace permits `src/**`, `public/**`, and selected root configs; `supabase/migrations/**` is not writable through those tools. Do not ask the user to apply SQL manually.

Tool input examples (replace the illustrative SQL/source with the actual implementation):

```json
{"action":"inspect_schema"}
{"action":"apply_migration","name":"create_profiles","sql":"..."}
{"action":"configure_auth"}
{"action":"create_bucket","name":"avatars","public":false,"allowedMimeTypes":["image/png","image/jpeg"],"fileSizeLimit":5242880}
{"action":"deploy_function","name":"profile_lookup","source":"..."}
```

Resource names start with a lowercase letter and contain only lowercase letters, digits, underscores, or hyphens (maximum 63 characters).

## Database and RLS

1. Call `backend` action `inspect_schema` before designing changes to an existing project.
2. Use action `apply_migration` with a stable descriptive migration name and SQL. The host records migrations transactionally and recognizes repeated identical migrations. Do not reuse a migration name for different SQL. Prefer additive changes; destructive changes require the user's explicit request.
3. Create tables, indexes, constraints, grants, and RLS policies in the migration. Enable RLS on every exposed user-data table. Add policies for each required operation, including `WITH CHECK` for writes, scoped to `authenticated` and ownership via `(select auth.uid()) = user_id`. Test anonymous access and access by a second user; a successful request as the owner alone does not establish isolation.
4. Use anon/publishable credentials with the user's verified session for ordinary reads and writes. Service-role credentials bypass RLS: use them only in server modules marked `import "server-only"`, after authentication and authorization for the operation. Never expose a general admin query endpoint or trust a client-supplied owner ID.
5. Do not create tables or seed user data at page-render time. Separate required migrations from optional fixtures, and do not claim persistence works until the migration has succeeded.
6. Views must use `security_invoker = true` so they preserve the caller's RLS boundary. Database functions should use invoker rights by default; any `SECURITY DEFINER` function needs a fixed safe `search_path`, explicit caller/ownership checks, and narrowly granted execute rights. Revoke default public execute access from privileged RPCs. Never treat the migration's RLS gate as a policy or function security audit.

## Auth (Next.js App Router)

- Reuse `supabaseCookieOptions` from `@/lib/supabase/cookie-options` in every `createBrowserClient` and `createServerClient` call, including Proxy, callback handlers, and Server Actions. Pass it as `cookieOptions: supabaseCookieOptions` and forward the full options received by each `setAll` adapter when setting response cookies. Keep the same options for sign-in, refresh, and sign-out.
- If an older starter lacks the module, add it with this implementation. The host sets the marker only when launching the managed preview dev server:

  ```ts
  export const supabaseCookieOptions =
    process.env.NODE_ENV === "development" &&
    process.env.NEXT_PUBLIC_BABY_LOVABLE_EMBEDDED_PREVIEW === "1"
      ? { sameSite: "none" as const, secure: true, partitioned: true, path: "/" }
      : undefined;
  ```

- Verify password sign-in in the builder's embedded HTTPS preview, reload to verify the session persists, then sign out and reload again. A successful login in a separate tab does not verify the iframe. Test email confirmation and OAuth callbacks separately: a callback opened as a top-level page may use a different cookie partition from the embedded app. Do not log cookie values or prefill credentials.
- Browser client: `src/lib/supabase/client.ts`, using `createBrowserClient` from `@supabase/ssr`.
- Server client: `src/lib/supabase/server.ts`, using `createServerClient` and `await cookies()` from `next/headers`, with `getAll`/`setAll` cookie adapters. Cookie writes belong in Route Handlers, Server Actions, or Proxy responses; Server Components cannot set cookies.
- Refresh sessions through `src/proxy.ts` for Next.js 16. Preserve refreshed cookies on both the request used for rendering and the returned response. Proxy redirects are only an early check: authorize every protected Route Handler, Server Action, and data-access function too.
- Verify identity server-side with `supabase.auth.getClaims()` or `getUser()`. Do not authorize using the unverified user returned by `getSession()` alone.
- Implement signup, login, logout, pending email confirmation, and visible errors. Email confirmation may return no session; do not immediately present an authenticated state.
- For magic links or OAuth, implement a callback Route Handler that exchanges the authorization code with `exchangeCodeForSession`. Restrict any post-login `next` redirect to a local path; reject `//`, backslashes, and external URLs.
- Create the callback at `/auth/callback`, then call `backend` with `{"action":"configure_auth"}` (no extra parameters). The host adds that path for the session's trusted preview/published URLs while preserving existing redirect entries. Re-run after publication or a preview-domain change. The tool does not configure email templates, SMTP, or third-party OAuth provider credentials; state those setup requirements if the requested flow needs them.
- For profiles, use a table keyed by the Auth user ID and appropriate RLS. Handle missing profiles rather than assuming every Auth user has a profile row.

## Storage

- Call `backend` action `create_bucket` for a required bucket; use private buckets (`public: false`) for user uploads. Public buckets are suitable only for deliberately public assets.
- Add scoped policies on `storage.objects` through `apply_migration` for each needed upload/read/update/delete operation. Restrict both `bucket_id` and the owner/path (for example the first path segment equals `auth.uid()::text`). Creating a bucket does not create its access policies.
- Supply the required `allowedMimeTypes` array and an appropriate `fileSizeLimit` to `create_bucket` (default 10 MiB; maximum 50 MiB). Validate uploads on the server too. Serve private files through short-lived signed URLs after checking access. Never treat a public URL as a privacy control.

## Edge Functions

Use `backend` action `deploy_function` with `name` and `source`. Source must be a single bundled TypeScript module: do not reference local files that will not be uploaded. The host always enables JWT verification; the tool has no verification-disable parameter. Validate the caller and authorization inside the function as well. Public webhook functions are outside this tool's scope; use an app Route Handler with provider signature verification for that requirement.

Do not embed secrets in function source. If additional provider secrets are required and the tool cannot configure them, state that exact remaining setup step; do not claim the function is operational. Include appropriate CORS behavior for intended browser callers without weakening authentication.

## Verification

Call `checkPreview` after substantial code/config changes and resolve compile errors. Check `backend` results for successful migrations, bucket creation, Auth configuration, and function deployment. An HTTP-ready preview proves compilation and reachability; it does not prove login, RLS, uploads, or function authorization. Exercise the relevant flow when test credentials are available and describe any remaining verification precisely.
