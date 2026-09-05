# Supabase migrations

Schema changes are files under `supabase/migrations/`. Local Docker is the only place to apply them by hand. Production is applied by GitHub Actions after merge to `main`.

## Local (laptop / agent)

`supabase start` applies pending migrations. To apply new files without wiping data:

```bash
supabase db push --local
```

The `--local` flag is required. Bare `supabase db push` can target the linked remote project (`baby-lovable-us` and similar).

To wipe local data and replay every migration plus `supabase/seed.sql`:

```bash
supabase db reset
```

Do **not** from a laptop:

- `supabase db push` without `--local`
- `supabase db push --linked`
- `supabase db reset --linked`
- schema-changing SQL via `supabase db query --linked` or the hosted Dashboard SQL editor

Day-to-day Studio / keys: [Local Supabase + Studio](./local-supabase.md).

## Production (GitHub Actions)

Workflow: [`.github/workflows/supabase-production.yaml`](../.github/workflows/supabase-production.yaml)

| Trigger | When |
| --- | --- |
| `push` to `main` | Merge that touches `supabase/migrations/**` (or this workflow file) |
| `workflow_dispatch` | Manual run from the Actions tab — not from local CLI |

The job links the production project and runs `supabase db push --yes`. It is idempotent: already-applied versions are skipped.

PRs also start a throwaway local stack and apply the same files ([`.github/workflows/supabase-ci.yaml`](../.github/workflows/supabase-ci.yaml)). That check does not touch production.

### Required repository secrets

GitHub → **Settings → Secrets and variables → Actions**:

| Secret | Source |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN` | [Account → Access Tokens](https://supabase.com/dashboard/account/tokens) |
| `PRODUCTION_PROJECT_ID` | Project ref in the Dashboard URL (`https://supabase.com/dashboard/project/<ref>`) |

The latest CLI logs in with a temporary role from the access token. Do **not** reset the hosted database password for this workflow, and do not put that password in Vercel — the app uses the API keys (`NEXT_PUBLIC_SUPABASE_*` / `SUPABASE_SECRET_KEY`), not a Postgres login.

There is no staging project in this repo yet, so there is no staging workflow.

### First production deploy after adding the workflow

1. Confirm the two secrets above are set.
2. Merge to `main` (or run **Deploy Migrations to Production**).
3. Confirm the Action succeeded and `supabase_migrations.schema_migrations` on the hosted project matches `supabase/migrations/`.
