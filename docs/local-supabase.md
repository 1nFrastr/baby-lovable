# Local Supabase + Studio

Run a full local Supabase stack (API, Postgres, Auth, Realtime, **Studio**) via Docker so you can inspect and mutate session metadata without touching the linked remote project or opening the hosted Dashboard.

**Requires Docker Desktop** (or another Docker engine). There is no non-Docker Studio path in this repo.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) running (`docker info` succeeds)
- [Supabase CLI](https://supabase.com/docs/guides/cli) (`brew install supabase/tap/supabase` or see docs)
- Repo migrations under `supabase/migrations/` (baseline: `20260829010000_baseline.sql`)

## Start / stop / status

From the repo root:

```bash
supabase start          # pull images (first run), apply migrations + seed, print URLs/keys
supabase status         # API URL, Studio URL, anon / service_role keys
supabase stop           # stop containers (data volume kept)
supabase stop --no-backup   # stop and discard local DB volume
```

Typical ports (see `supabase/config.toml`):

| Service | URL |
| --- | --- |
| API (Kong) | http://127.0.0.1:54321 |
| Studio (Table Editor) | http://127.0.0.1:54323 |
| DB (direct) | postgresql://postgres:postgres@127.0.0.1:54322/postgres |

Open **Studio** → **Table Editor** to inspect `sessions`, `session_messages`, and related tables.

## Point the app / CLI at local

Local Host uses a single gitignored **`.env.local`**. Keep it on local Supabase. Hosted / production secrets stay on the **Vercel Dashboard** only.

```bash
# After `supabase start`, set in .env.local:
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
# Prefer ANON_KEY / SERVICE_ROLE_KEY from `supabase status`
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<ANON_KEY>
SUPABASE_SECRET_KEY=<SERVICE_ROLE_KEY>
BABY_LOVABLE_DEV_USER_ID=11111111-1111-1111-1111-111111111111
```

Restart `npm run dev` / `npm run agent` after changing `.env.local`.

Default local JWT keys are stable demo secrets for the stock stack; still copy from `supabase status` so you do not drift if config changes.

## Migrations (local)

`supabase start` applies pending migrations. To wipe local data and re-apply the baseline + seed:

```bash
supabase db reset
```

That runs migrations in `supabase/migrations/`, then `supabase/seed.sql`.

To push only new migration files against the already-running local DB (without wiping):

```bash
supabase db push --local
```

The `--local` flag is **required**. Bare `supabase db push` can target the linked remote project. Production schema is applied by GitHub Actions, not from a laptop — see [Supabase migrations](./supabase-migrations.md).

## Local vs linked remote

| | Local (`supabase start`) | Linked remote / Vercel |
| --- | --- | --- |
| Purpose | Isolated schema/data debugging next to `npm run dev` / agent | Shared / prod project |
| Studio | http://127.0.0.1:54323 | Hosted Dashboard |
| Env | `.env.local` → `127.0.0.1:54321` | Vercel Environment Variables |
| Destructive SQL | Safe to reset / truncate | **Never** “just debug” with truncate / `db reset --linked` |

**Foot-guns**

- Always pass `--local` to `supabase db push`. Bare `db push` or `--linked` can mutate the hosted project.
- Do **not** run `supabase db reset --linked` or destructive / schema SQL against the linked project while iterating.
- Do not put hosted Supabase keys in day-to-day `.env.local`.
- Deploy / shared preview use Vercel env — this guide does not replace that.
- Production migrations: merge to `main` (or Actions `workflow_dispatch`). See [Supabase migrations](./supabase-migrations.md).

## Seed user (optional detail)

[`supabase/seed.sql`](../supabase/seed.sql) inserts a deterministic Auth user:

| Field | Value |
| --- | --- |
| id | `11111111-1111-1111-1111-111111111111` |
| email | `dev@localhost.local` |
| password | `password` |

Re-seed after a wipe with `supabase db reset`. To create a different user instead, use Studio **Authentication** → **Users**, or:

```bash
# example: create via Auth admin after stack is up
curl -s "http://127.0.0.1:54321/auth/v1/admin/users" \
  -H "apikey: $SUPABASE_SECRET_KEY" \
  -H "Authorization: Bearer $SUPABASE_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"password","email_confirm":true}'
```

Then set `BABY_LOVABLE_DEV_USER_ID` to the returned `id`.

## Smoke checklist

1. `docker info` OK → `supabase start` finishes without error.
2. Open http://127.0.0.1:54323 → Table Editor shows `sessions` / `session_messages` (empty is fine).
3. `.env.local` points at local URL + keys + seed `BABY_LOVABLE_DEV_USER_ID`.
4. `npm run agent -- -l` (or create a session via web) succeeds against local.
5. Refresh Studio: new rows appear under `sessions` / `session_messages`.

## Related

- [Local development guide](./local-development.md)
- [Supabase migrations](./supabase-migrations.md) — local `--local` vs production GitHub Actions
- Schema baseline: `supabase/migrations/20260829010000_baseline.sql`
- Env template: `.env.example`
