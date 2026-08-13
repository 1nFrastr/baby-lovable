-- Replace OAuth user-token bindings with non-secret GitHub App installation metadata.

drop table if exists public.user_github_app_bindings;

create table if not exists public.user_github_app_installations (
  user_id            uuid        primary key references auth.users (id) on delete cascade,
  installation_id    bigint      not null unique,
  github_account_id  bigint      not null,
  github_login       text        not null,
  updated_at         timestamptz not null default now()
);

alter table public.user_github_app_installations enable row level security;

create policy "user_github_app_installations_select_own"
  on public.user_github_app_installations for select
  using (auth.uid() = user_id);
