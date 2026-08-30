# Local development guide

Local Host and production share the same execution path: Daytona runs the workspace; Freestyle `main` persists source. The repo does not provide a local sandbox or local Preview simulation.

## Quick start

```bash
pnpm install
cp .env.example .env.local

# Required in .env.local (local Supabase):
# AI_GATEWAY_API_KEY (or VERCEL_OIDC_TOKEN)
# NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
# NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY (from `supabase status`)
# BABY_LOVABLE_DEV_USER_ID (seed: 11111111-1111-1111-1111-111111111111)
# DAYTONA_API_KEY
# FREESTYLE_API_KEY

npm run dev
```

Supabase is the only metadata backend; local Host no longer provides a JSON-file fallback. Day-to-day `.env.local` stays on **local** Supabase; hosted credentials live on Vercel only. The Agent workspace always runs on Daytona; source always uses Freestyle `main` as the source of truth.

### Local Supabase (recommended for DB debugging)

Prefer a Docker local stack + Studio so you do not mutate the linked remote project while iterating. See **[Local Supabase + Studio](./local-supabase.md)**.

```bash
supabase start
# put URL + ANON_KEY / SERVICE_ROLE_KEY into .env.local
```

## CLI (recommended for verification)

CLI and Web use the same Builder Agent, Daytona reconciler, and Freestyle checkpoint:

```bash
npm run agent -- -h
npm run agent -- -l
npm run agent -- -p "Create a todo app"
npm run agent -- -s sess_abc123 -p "Add a gradient"
npm run agent
```

Common flags: `-p` for a single turn then exit, `-s` to reuse a session, `--max-steps`. Sandbox is not selectable; passing the old `--sandbox` flag errors immediately.

## Local vs production differences

| Capability | Local Host | Production Host |
| --- | --- | --- |
| Session metadata | Supabase | Supabase |
| Auth | Supabase Auth + RLS | Supabase Auth + RLS |
| Agent workspace | Daytona Sandbox | Daytona Sandbox |
| Source of truth | Freestyle `main` | Freestyle `main` |
| Runtime push | Supabase Realtime | Supabase Realtime |

## Verification

- Use the Supabase session row and CLI trace to inspect tool calls and the final reply.
- The last `checkPreview` result must be `ok: true`.
- Source and versions are authoritative on Freestyle `main`; the Daytona working tree is a runtime projection.
- After Host code changes, run `npm run lint`, `npm test`, and `npm run build`.
