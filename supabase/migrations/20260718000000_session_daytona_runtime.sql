-- Daytona runtime control-plane snapshot (desired / observed / lease).
-- Cross-isolate source of truth for Vercel / Workflow steps.

create table if not exists public.session_daytona_runtime (
  session_id            text        primary key references public.sessions (id) on delete cascade,
  user_id               uuid        references auth.users (id) on delete cascade,
  revision              int         not null default 0,
  generation            int         not null default 0,
  desired               text        not null,
  observed              text        not null,
  sandbox_id            text        null,
  dev_session_name      text        null,
  preview_url           text        null,
  preview_port          int         null,
  preview_expires_at_ms bigint      null,
  last_error            text        null,
  last_observed_at      timestamptz null,
  lease_owner           text        null,
  lease_expires_at      timestamptz null,
  clear_next_cache      boolean     not null default false,
  updated_at            timestamptz not null default now()
);

create index if not exists session_daytona_runtime_user_id_idx
  on public.session_daytona_runtime (user_id);

create index if not exists session_daytona_runtime_lease_expires_at_idx
  on public.session_daytona_runtime (lease_expires_at);

alter table public.session_daytona_runtime enable row level security;

create policy "session_daytona_runtime_select_own"
  on public.session_daytona_runtime for select
  using (auth.uid() = user_id);

create policy "session_daytona_runtime_insert_own"
  on public.session_daytona_runtime for insert
  with check (auth.uid() = user_id);

create policy "session_daytona_runtime_update_own"
  on public.session_daytona_runtime for update
  using (auth.uid() = user_id);

create policy "session_daytona_runtime_delete_own"
  on public.session_daytona_runtime for delete
  using (auth.uid() = user_id);
