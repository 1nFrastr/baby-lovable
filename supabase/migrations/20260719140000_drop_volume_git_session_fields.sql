-- Drop unused Daytona volume / git session columns (never wired in app code).
-- Sandbox identity lives in session_daytona_runtime, not sessions.

alter table public.sessions
  drop column if exists volume_subpath,
  drop column if exists daytona_sandbox_id,
  drop column if exists last_commit_sha,
  drop column if exists git_remote;
