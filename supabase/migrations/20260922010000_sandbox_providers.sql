-- Multi-provider sandbox runtime: rename Daytona table, allow vercel sessions.

alter table public.sessions
  drop constraint if exists sessions_sandbox_mode_check;

alter table public.sessions
  add constraint sessions_sandbox_mode_check
  check (sandbox_mode in ('daytona', 'vercel'));

alter table public.sessions
  alter column sandbox_mode set default 'vercel';

alter table public.session_daytona_runtime
  rename to session_sandbox_runtime;

alter index if exists session_daytona_runtime_user_id_idx
  rename to session_sandbox_runtime_user_id_idx;

alter index if exists session_daytona_runtime_lease_expires_at_idx
  rename to session_sandbox_runtime_lease_expires_at_idx;

alter table public.session_sandbox_runtime
  add column if not exists provider text not null default 'daytona';

alter table public.session_sandbox_runtime
  add column if not exists provider_meta jsonb not null default '{}'::jsonb;

alter table public.session_sandbox_runtime
  drop constraint if exists session_sandbox_runtime_provider_check;

alter table public.session_sandbox_runtime
  add constraint session_sandbox_runtime_provider_check
  check (provider in ('daytona', 'vercel'));

do $$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'session_sandbox_runtime'
      and policyname = 'session_daytona_runtime_select_own'
  ) then
    alter policy session_daytona_runtime_select_own
      on public.session_sandbox_runtime rename to session_sandbox_runtime_select_own;
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'session_sandbox_runtime'
      and policyname = 'session_daytona_runtime_insert_own'
  ) then
    alter policy session_daytona_runtime_insert_own
      on public.session_sandbox_runtime rename to session_sandbox_runtime_insert_own;
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'session_sandbox_runtime'
      and policyname = 'session_daytona_runtime_update_own'
  ) then
    alter policy session_daytona_runtime_update_own
      on public.session_sandbox_runtime rename to session_sandbox_runtime_update_own;
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'session_sandbox_runtime'
      and policyname = 'session_daytona_runtime_delete_own'
  ) then
    alter policy session_daytona_runtime_delete_own
      on public.session_sandbox_runtime rename to session_sandbox_runtime_delete_own;
  end if;
end
$$;
