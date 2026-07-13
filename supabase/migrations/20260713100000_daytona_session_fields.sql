-- Daytona volume + sandbox tracking for remote workspaces

alter table public.sessions
  add column if not exists volume_subpath text,
  add column if not exists daytona_sandbox_id text,
  add column if not exists last_commit_sha text;
