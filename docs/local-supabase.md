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

### One-click switch (recommended)

Keep shared secrets in `.env.local`. Supabase URL/keys live in gitignored profiles and are swapped in place:

```bash
npm run supabase:use-local    # → Docker stack (auto `supabase status` + seed user)
npm run supabase:use-remote   # → linked / hosted project
npm run supabase:use -- status
```

First switch to **local** snapshots the current remote keys into `.env.supabase.remote` so you can switch back. Profiles:

| File | Purpose |
| --- | --- |
| `.env.supabase.local` | Local stack (refreshed from `supabase status`) |
| `.env.supabase.remote` | Hosted project |

Examples: `.env.supabase.local.example`, `.env.supabase.remote.example`.

Restart `npm run dev` / `npm run agent` after switching.

### Manual values

If you prefer editing by hand:

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
# Prefer the JWT values named ANON_KEY / SERVICE_ROLE_KEY from `supabase status`
# (status may also print newer sb_publishable_ / sb_secret_ keys — either works with current clients)
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<ANON_KEY>
SUPABASE_SECRET_KEY=<SERVICE_ROLE_KEY>
BABY_LOVABLE_DEV_USER_ID=11111111-1111-1111-1111-111111111111
```

Default local JWT keys are stable demo secrets for the stock stack; still copy from `supabase status` so you do not drift if config changes.

## Migrations (local)

`supabase start` applies pending migrations. To wipe local data and re-apply the baseline + seed:

```bash
supabase db reset
```

That runs migrations in `supabase/migrations/`, then `supabase/seed.sql`.

To push only new migration files against the already-running local DB (without wiping):

```bash
supabase db push
```

(omit `--linked`; default target is the local stack when it is running)

## Local vs linked remote

| | Local (`supabase start`) | Linked remote (`supabase link`) |
| --- | --- | --- |
| Purpose | Isolated schema/data debugging next to `npm run dev` / agent | Shared / prod-like project; Vercel & team |
| Studio | http://127.0.0.1:54323 | Hosted Dashboard |
| Env | `.env.local` → `127.0.0.1:54321` | `.env.local` → project URL |
| Destructive SQL | Safe to reset / truncate | **Never** “just debug” with truncate / `db reset --linked` |

**Foot-guns**

- Do **not** run `supabase db reset --linked` or destructive SQL against the linked project while iterating.
- Keep remote credentials out of day-to-day local debugging; switch `.env.local` deliberately when you need remote.
- Deploy / shared preview still use the remote Supabase project — this guide does not replace that.

Useful remote-only commands (when you intentionally need them):

```bash
supabase link                 # one-time project link
supabase db push --linked     # apply migrations to remote
supabase db query --linked "select count(*) from public.sessions;"
```

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
6. Confirm `.env.local` is **not** still pointing at the remote project URL if you intended local-only work.

## Related

- [Local development guide](./local-development.md)
- Schema baseline: `supabase/migrations/20260829010000_baseline.sql`
- Env template: `.env.example`
