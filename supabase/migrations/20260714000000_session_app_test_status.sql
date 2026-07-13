-- Live View / app-test status for cross-isolate Web UI polling (Vercel).
-- Sidecar table (like session_drafts) so chat message updates never clobber it.

create table if not exists public.session_app_test_status (
  session_id  text        primary key references public.sessions (id) on delete cascade,
  user_id     uuid        not null references auth.users (id) on delete cascade,
  status      jsonb       not null default '{"status":"idle"}'::jsonb,
  updated_at  timestamptz not null default now()
);

create index if not exists session_app_test_status_user_id_idx
  on public.session_app_test_status (user_id);

alter table public.session_app_test_status enable row level security;

create policy "session_app_test_status_select_own"
  on public.session_app_test_status for select
  using (auth.uid() = user_id);

create policy "session_app_test_status_insert_own"
  on public.session_app_test_status for insert
  with check (auth.uid() = user_id);

create policy "session_app_test_status_update_own"
  on public.session_app_test_status for update
  using (auth.uid() = user_id);

create policy "session_app_test_status_delete_own"
  on public.session_app_test_status for delete
  using (auth.uid() = user_id);
