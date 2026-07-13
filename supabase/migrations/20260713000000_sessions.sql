-- baby-lovable session + draft tables
-- Apply via Supabase Studio SQL Editor or `supabase db push`.

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
create table if not exists public.sessions (
  id            text        primary key,
  user_id       uuid        not null references auth.users (id) on delete cascade,
  schema_version int        not null default 2,
  title         text        not null default 'New Project',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  messages      jsonb       not null default '[]'::jsonb,
  last_run_id   text,
  run_status    text        not null default 'idle'
                check (run_status in ('idle','pending','running','completed','failed','cancelled')),
  sandbox_mode  text        not null default 'local'
                check (sandbox_mode in ('local','daytona')),
  git_remote    text,
  deleted_at    timestamptz
);

create index if not exists sessions_user_id_updated_at_idx
  on public.sessions (user_id, updated_at desc)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- session_drafts  (in-flight assistant message cache)
-- ---------------------------------------------------------------------------
create table if not exists public.session_drafts (
  session_id  text        primary key references public.sessions (id) on delete cascade,
  user_id     uuid        not null references auth.users (id) on delete cascade,
  run_id      text        not null,
  message     jsonb       not null,
  updated_at  timestamptz not null default now()
);

create index if not exists session_drafts_user_id_idx
  on public.session_drafts (user_id);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.sessions enable row level security;
alter table public.session_drafts enable row level security;

create policy "sessions_select_own"
  on public.sessions for select
  using (auth.uid() = user_id and deleted_at is null);

create policy "sessions_insert_own"
  on public.sessions for insert
  with check (auth.uid() = user_id);

create policy "sessions_update_own"
  on public.sessions for update
  using (auth.uid() = user_id);

create policy "sessions_delete_own"
  on public.sessions for delete
  using (auth.uid() = user_id);

create policy "session_drafts_select_own"
  on public.session_drafts for select
  using (auth.uid() = user_id);

create policy "session_drafts_insert_own"
  on public.session_drafts for insert
  with check (auth.uid() = user_id);

create policy "session_drafts_update_own"
  on public.session_drafts for update
  using (auth.uid() = user_id);

create policy "session_drafts_delete_own"
  on public.session_drafts for delete
  using (auth.uid() = user_id);

-- Auto-bump updated_at on sessions
create or replace function public.set_sessions_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists sessions_updated_at on public.sessions;
create trigger sessions_updated_at
  before update on public.sessions
  for each row execute function public.set_sessions_updated_at();
