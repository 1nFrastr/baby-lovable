-- Insert compaction nail + summary before the current user message.
-- Turn-fenced CAS. Idempotent on the nail message id.

create or replace function public.cas_insert_compaction_messages(
  p_session_id text,
  p_expected_revision bigint,
  p_expected_turn_id text,
  p_before_message_id text,
  p_nail jsonb,
  p_summary jsonb
)
returns setof public.sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.sessions;
  v_pos integer;
  v_nail_id text := p_nail->>'id';
  v_summary_id text := p_summary->>'id';
begin
  if v_nail_id is null or v_nail_id = '' then
    raise exception 'compaction nail id is required';
  end if;
  if v_summary_id is null or v_summary_id = '' then
    raise exception 'compaction summary id is required';
  end if;
  if coalesce(p_nail->>'role', '') <> 'user' then
    raise exception 'compaction nail must have role user';
  end if;
  if coalesce(p_summary->>'role', '') <> 'assistant' then
    raise exception 'compaction summary must have role assistant';
  end if;

  -- Idempotent replay: both rows already exist.
  if exists (
    select 1
    from public.session_messages
    where session_id = p_session_id
      and message_id = v_nail_id
  ) and exists (
    select 1
    from public.session_messages
    where session_id = p_session_id
      and message_id = v_summary_id
  ) then
    select * into v_session from public.sessions where id = p_session_id;
    return next v_session;
    return;
  end if;

  update public.sessions
  set
    conversation_revision = conversation_revision + 1,
    schema_version = 4,
    updated_at = now(),
    message_count = message_count + 2
  where id = p_session_id
    and conversation_revision = p_expected_revision
    and active_turn_id = p_expected_turn_id
    and run_status in ('pending', 'running')
  returning * into v_session;

  if not found then
    return;
  end if;

  select position
  into v_pos
  from public.session_messages
  where session_id = p_session_id
    and message_id = p_before_message_id;

  if not found then
    raise exception 'before message % not found in session %',
      p_before_message_id, p_session_id;
  end if;

  -- Unique (session_id, position) is checked per row; shift in two steps.
  update public.session_messages
  set position = position + 1000000
  where session_id = p_session_id
    and position >= v_pos;

  update public.session_messages
  set position = position - 1000000 + 2
  where session_id = p_session_id
    and position >= 1000000;

  insert into public.session_messages (
    session_id,
    message_id,
    position,
    role,
    message
  )
  values
    (p_session_id, v_nail_id, v_pos, 'user', p_nail),
    (p_session_id, v_summary_id, v_pos + 1, 'assistant', p_summary);

  return next v_session;
end;
$$;
