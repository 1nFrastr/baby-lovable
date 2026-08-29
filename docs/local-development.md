# Local development guide

Local Host and production share the same execution path: Daytona runs the workspace; Freestyle `main` persists source. The repo does not provide a local sandbox or local Preview simulation.

## Quick start

```bash
pnpm install
cp .env.example .env.local

# Required:
# AI_GATEWAY_API_KEY (or VERCEL_OIDC_TOKEN)
# NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
# SUPABASE_SECRET_KEY / BABY_LOVABLE_DEV_USER_ID
# DAYTONA_API_KEY
# FREESTYLE_API_KEY

npm run dev
```

Supabase is the only metadata backend; local Host no longer provides a JSON-file fallback. `BABY_LOVABLE_DEV_USER_ID` must be a real `auth.users.id` in the current Supabase project. The Agent workspace always runs on Daytona; source always uses Freestyle `main` as the source of truth.

### Local Supabase (recommended for DB debugging)

Prefer a Docker local stack + Studio so you do not mutate the linked remote project while iterating. See **[Local Supabase + Studio](./local-supabase.md)** (`supabase start`, Studio at http://127.0.0.1:54323, one-click env switch, migrations, seed user).

```bash
supabase start
npm run supabase:use-local    # snapshot remote keys, point .env.local at local
# … debug …
npm run supabase:use-remote   # point back at hosted project
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
