-- Freestyle Git repository binding per session (sidecar; not on sessions row).

create table if not exists public.session_git_repositories (
  session_id  text        primary key references public.sessions (id) on delete cascade,
  user_id     uuid        not null references auth.users (id) on delete cascade,
  repository  jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

create index if not exists session_git_repositories_user_id_idx
  on public.session_git_repositories (user_id);

alter table public.session_git_repositories enable row level security;

create policy "session_git_repositories_select_own"
  on public.session_git_repositories for select
  using (auth.uid() = user_id);

create policy "session_git_repositories_insert_own"
  on public.session_git_repositories for insert
  with check (auth.uid() = user_id);

create policy "session_git_repositories_update_own"
  on public.session_git_repositories for update
  using (auth.uid() = user_id);

create policy "session_git_repositories_delete_own"
  on public.session_git_repositories for delete
  using (auth.uid() = user_id);

-- Per-turn Freestyle sync / checkpoint tasks (unique session_id + run_id).

create table if not exists public.session_git_sync_tasks (
  session_id  text        not null references public.sessions (id) on delete cascade,
  run_id      text        not null,
  user_id     uuid        not null references auth.users (id) on delete cascade,
  task        jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  primary key (session_id, run_id)
);

create index if not exists session_git_sync_tasks_user_id_idx
  on public.session_git_sync_tasks (user_id);

create index if not exists session_git_sync_tasks_session_status_idx
  on public.session_git_sync_tasks (session_id, ((task->>'status')));

alter table public.session_git_sync_tasks enable row level security;

create policy "session_git_sync_tasks_select_own"
  on public.session_git_sync_tasks for select
  using (auth.uid() = user_id);

create policy "session_git_sync_tasks_insert_own"
  on public.session_git_sync_tasks for insert
  with check (auth.uid() = user_id);

create policy "session_git_sync_tasks_update_own"
  on public.session_git_sync_tasks for update
  using (auth.uid() = user_id);

create policy "session_git_sync_tasks_delete_own"
  on public.session_git_sync_tasks for delete
  using (auth.uid() = user_id);
