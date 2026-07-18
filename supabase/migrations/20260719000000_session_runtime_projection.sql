-- Unified SessionRuntimeProjection — sole UI read model for run / preview / appTest.
-- Transport: Supabase Realtime (postgres_changes) when this table is the persist backend.

create table if not exists public.session_runtime_projection (
  session_id  text        primary key references public.sessions (id) on delete cascade,
  user_id     uuid        not null references auth.users (id) on delete cascade,
  version     int         not null default 0,
  projection  jsonb       not null,
  updated_at  timestamptz not null default now()
);

create index if not exists session_runtime_projection_user_id_idx
  on public.session_runtime_projection (user_id);

alter table public.session_runtime_projection enable row level security;

create policy "session_runtime_projection_select_own"
  on public.session_runtime_projection for select
  using (auth.uid() = user_id);

create policy "session_runtime_projection_insert_own"
  on public.session_runtime_projection for insert
  with check (auth.uid() = user_id);

create policy "session_runtime_projection_update_own"
  on public.session_runtime_projection for update
  using (auth.uid() = user_id);

create policy "session_runtime_projection_delete_own"
  on public.session_runtime_projection for delete
  using (auth.uid() = user_id);

-- Realtime: browser subscribes with user JWT; RLS filters by ownership.
alter publication supabase_realtime add table public.session_runtime_projection;
