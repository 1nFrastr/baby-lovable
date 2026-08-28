-- One row per UIMessage. Turn progress updates a single assistant row instead of
-- rewriting sessions.messages jsonb. Lease + CAS stay on public.sessions.

alter table public.sessions
  add column if not exists message_count integer not null default 0;

create table if not exists public.session_messages (
  session_id   text        not null references public.sessions (id) on delete cascade,
  message_id   text        not null,
  position     integer     not null,
  role         text        not null check (role in ('user', 'assistant', 'system')),
  message      jsonb       not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (session_id, message_id),
  constraint session_messages_position_nonneg check (position >= 0)
);

create unique index if not exists session_messages_session_position_uidx
  on public.session_messages (session_id, position);

create index if not exists session_messages_session_id_idx
  on public.session_messages (session_id);

-- Backfill from legacy jsonb array.
insert into public.session_messages (session_id, message_id, position, role, message)
select
  s.id,
  msg->>'id',
  (ordinality - 1)::integer,
  msg->>'role',
  msg
from public.sessions s
cross join lateral jsonb_array_elements(coalesce(s.messages, '[]'::jsonb))
  with ordinality as t(msg, ordinality)
where msg->>'id' is not null
  and msg->>'role' is not null
on conflict (session_id, message_id) do nothing;

update public.sessions s
set message_count = (
  select count(*)::integer
  from public.session_messages sm
  where sm.session_id = s.id
);

-- Legacy column kept for rollback; application reads session_messages only.
update public.sessions
set messages = '[]'::jsonb
where message_count > 0;

update public.sessions
set schema_version = 4
where schema_version < 4;

-- ---------------------------------------------------------------------------
-- Row Level Security (mirrors sessions ownership)
-- ---------------------------------------------------------------------------
alter table public.session_messages enable row level security;

create policy "session_messages_select_own"
  on public.session_messages for select
  using (
    exists (
      select 1
      from public.sessions s
      where s.id = session_id
        and s.user_id = auth.uid()
        and s.deleted_at is null
    )
  );

create policy "session_messages_insert_own"
  on public.session_messages for insert
  with check (
    exists (
      select 1
      from public.sessions s
      where s.id = session_id
        and s.user_id = auth.uid()
    )
  );

create policy "session_messages_update_own"
  on public.session_messages for update
  using (
    exists (
      select 1
      from public.sessions s
      where s.id = session_id
        and s.user_id = auth.uid()
    )
  );

create policy "session_messages_delete_own"
  on public.session_messages for delete
  using (
    exists (
      select 1
      from public.sessions s
      where s.id = session_id
        and s.user_id = auth.uid()
    )
  );

create or replace function public.set_session_messages_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists session_messages_updated_at on public.session_messages;
create trigger session_messages_updated_at
  before update on public.session_messages
  for each row execute function public.set_session_messages_updated_at();

-- ---------------------------------------------------------------------------
-- Atomic CAS + message mutations (service_role / security definer)
-- ---------------------------------------------------------------------------

create or replace function public.cas_claim_session_turn(
  p_session_id text,
  p_expected_revision bigint,
  p_turn_id text,
  p_assistant_message_id text,
  p_user_message jsonb,
  p_assistant_message jsonb,
  p_title text,
  p_started_at timestamptz
)
returns setof public.sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.sessions;
  v_next_position integer;
begin
  update public.sessions
  set
    title = p_title,
    run_status = 'pending',
    last_run_id = null,
    active_turn_id = p_turn_id,
    active_assistant_message_id = p_assistant_message_id,
    active_turn_started_at = p_started_at,
    turn_checkpoint = -1,
    conversation_revision = conversation_revision + 1,
    schema_version = 4,
    updated_at = now(),
    message_count = message_count + 2
  where id = p_session_id
    and conversation_revision = p_expected_revision
    and active_turn_id is null
    and run_status not in ('pending', 'running', 'cancelling')
  returning * into v_session;

  if not found then
    return;
  end if;

  select coalesce(max(position) + 1, 0)
  into v_next_position
  from public.session_messages
  where session_id = p_session_id;

  insert into public.session_messages (session_id, message_id, position, role, message)
  values
    (
      p_session_id,
      p_user_message->>'id',
      v_next_position,
      p_user_message->>'role',
      p_user_message
    ),
    (
      p_session_id,
      p_assistant_message_id,
      v_next_position + 1,
      'assistant',
      p_assistant_message
    );

  return next v_session;
end;
$$;

create or replace function public.cas_update_assistant_message(
  p_session_id text,
  p_expected_revision bigint,
  p_expected_turn_id text,
  p_assistant_message_id text,
  p_message jsonb,
  p_turn_checkpoint integer default null
)
returns setof public.sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.sessions;
begin
  update public.sessions
  set
    conversation_revision = conversation_revision + 1,
    turn_checkpoint = coalesce(p_turn_checkpoint, turn_checkpoint),
    schema_version = 4,
    updated_at = now()
  where id = p_session_id
    and conversation_revision = p_expected_revision
    and active_turn_id = p_expected_turn_id
    and active_assistant_message_id = p_assistant_message_id
    and run_status in ('pending', 'running', 'cancelling')
  returning * into v_session;

  if not found then
    return;
  end if;

  update public.session_messages
  set
    message = p_message,
    role = p_message->>'role',
    updated_at = now()
  where session_id = p_session_id
    and message_id = p_assistant_message_id;

  if not found then
    raise exception 'assistant message row missing for session % message %',
      p_session_id, p_assistant_message_id;
  end if;

  return next v_session;
end;
$$;

create or replace function public.cas_terminal_session_turn(
  p_session_id text,
  p_expected_revision bigint,
  p_expected_turn_id text,
  p_assistant_message_id text,
  p_message jsonb,
  p_checkpoint integer,
  p_status text
)
returns setof public.sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.sessions;
begin
  if p_status not in ('completed', 'failed', 'cancelled') then
    raise exception 'invalid terminal status: %', p_status;
  end if;

  update public.sessions
  set
    run_status = p_status,
    last_run_id = null,
    active_turn_id = null,
    active_assistant_message_id = null,
    active_turn_started_at = null,
    turn_checkpoint = p_checkpoint,
    conversation_revision = conversation_revision + 1,
    schema_version = 4,
    updated_at = now()
  where id = p_session_id
    and conversation_revision = p_expected_revision
    and active_turn_id = p_expected_turn_id
    and active_assistant_message_id = p_assistant_message_id
  returning * into v_session;

  if not found then
    return;
  end if;

  if p_message is null then
    delete from public.session_messages
    where session_id = p_session_id
      and message_id = p_assistant_message_id;

    update public.sessions
    set message_count = greatest(message_count - 1, 0)
    where id = p_session_id;
  else
    update public.session_messages
    set
      message = p_message,
      role = p_message->>'role',
      updated_at = now()
    where session_id = p_session_id
      and message_id = p_assistant_message_id;

    if not found then
      raise exception 'assistant message row missing for session % message %',
        p_session_id, p_assistant_message_id;
    end if;
  end if;

  select * into v_session from public.sessions where id = p_session_id;
  return next v_session;
end;
$$;

create or replace function public.cas_replace_session_messages(
  p_session_id text,
  p_expected_revision bigint,
  p_messages jsonb
)
returns setof public.sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.sessions;
  v_msg jsonb;
  v_position integer := 0;
begin
  update public.sessions
  set
    conversation_revision = conversation_revision + 1,
    schema_version = 4,
    updated_at = now(),
    message_count = coalesce(jsonb_array_length(p_messages), 0)
  where id = p_session_id
    and conversation_revision = p_expected_revision
  returning * into v_session;

  if not found then
    return;
  end if;

  delete from public.session_messages
  where session_id = p_session_id;

  for v_msg in select value from jsonb_array_elements(coalesce(p_messages, '[]'::jsonb))
  loop
    insert into public.session_messages (session_id, message_id, position, role, message)
    values (
      p_session_id,
      v_msg->>'id',
      v_position,
      v_msg->>'role',
      v_msg
    );
    v_position := v_position + 1;
  end loop;

  return next v_session;
end;
$$;
