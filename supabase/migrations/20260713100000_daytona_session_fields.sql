-- Daytona session fields (historical). volume_subpath / last_commit_sha /
-- daytona_sandbox_id were never wired; dropped in 20260719140000.

alter table public.sessions
  add column if not exists volume_subpath text,
  add column if not exists daytona_sandbox_id text,
  add column if not exists last_commit_sha text;
