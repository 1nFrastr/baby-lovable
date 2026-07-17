-- Daytona signed preview URL cache (stable iframe origin / localStorage).
-- Sidecar table so chat message updates never clobber it; shared across
-- Vercel / Workflow isolates.

create table if not exists public.session_signed_preview (
  session_id  text        primary key references public.sessions (id) on delete cascade,
  user_id     uuid        not null references auth.users (id) on delete cascade,
  cache       jsonb       not null,
  updated_at  timestamptz not null default now()
);

create index if not exists session_signed_preview_user_id_idx
  on public.session_signed_preview (user_id);

alter table public.session_signed_preview enable row level security;

create policy "session_signed_preview_select_own"
  on public.session_signed_preview for select
  using (auth.uid() = user_id);

create policy "session_signed_preview_insert_own"
  on public.session_signed_preview for insert
  with check (auth.uid() = user_id);

create policy "session_signed_preview_update_own"
  on public.session_signed_preview for update
  using (auth.uid() = user_id);

create policy "session_signed_preview_delete_own"
  on public.session_signed_preview for delete
  using (auth.uid() = user_id);
