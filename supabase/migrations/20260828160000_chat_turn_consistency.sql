-- Authoritative chat turn lease + optimistic conversation revision.
--
-- `sessions.messages` remains the sole persisted conversation read model.
-- Active turn fields fence stale workflow/tool writes and make lifecycle
-- transitions conditional on the turn that owns the session.

alter table public.sessions
  add column if not exists active_turn_id text,
  add column if not exists active_assistant_message_id text,
  add column if not exists conversation_revision bigint not null default 0,
  add column if not exists turn_checkpoint integer not null default -1,
  add column if not exists active_turn_started_at timestamptz;

alter table public.sessions
  drop constraint if exists sessions_run_status_check;

alter table public.sessions
  add constraint sessions_run_status_check
  check (
    run_status in (
      'idle',
      'pending',
      'running',
      'cancelling',
      'completed',
      'failed',
      'cancelled'
    )
  );

update public.sessions
set schema_version = 3
where schema_version < 3;

create index if not exists sessions_active_turn_id_idx
  on public.sessions (active_turn_id)
  where active_turn_id is not null;
