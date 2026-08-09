-- Per-user GitHub App OAuth / installation binding (not session-scoped).

create table if not exists public.user_github_app_bindings (
  user_id     uuid        primary key references auth.users (id) on delete cascade,
  binding     jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table public.user_github_app_bindings enable row level security;

-- Users may read their own binding metadata; tokens are only written via
-- service-role (admin) from the app server. No insert/update policies for anon.
create policy "user_github_app_bindings_select_own"
  on public.user_github_app_bindings for select
  using (auth.uid() = user_id);
