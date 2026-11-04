-- Metadata only. Provider credentials, SQL, function source and app data never enter this log.
create table public.backend_operations (
  id uuid primary key,
  session_id text not null references public.sessions(id) on delete cascade,
  provider text not null check (provider in ('supabase', 'stripe', 'platform')),
  action text not null,
  resource text,
  content_digest text,
  status text not null check (status in ('running', 'succeeded', 'failed')),
  error_code text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index backend_operations_session_started_idx on public.backend_operations(session_id, started_at desc);
alter table public.backend_operations enable row level security;
revoke all on public.backend_operations from anon, authenticated;
grant all on public.backend_operations to service_role;
