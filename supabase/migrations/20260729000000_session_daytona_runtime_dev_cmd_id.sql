-- Persist Daytona pnpm-dev command id for preview console log reattach.
alter table public.session_daytona_runtime
  add column if not exists dev_cmd_id text null;
