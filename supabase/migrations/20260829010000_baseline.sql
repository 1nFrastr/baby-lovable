-- Baseline schema for baby-lovable (synced from remote DB).
-- Single source of truth: tables, indexes, RLS, triggers, CAS RPCs.

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
create table public.sessions (
  id                         text        primary key,
  user_id                    uuid        not null references auth.users (id) on delete cascade,
  schema_version             integer     not null default 4,
  title                      text        not null default 'New Project',
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  last_run_id                text,
  run_status                 text        not null default 'idle'
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
    ),
  sandbox_mode               text        not null default 'daytona'
    check (sandbox_mode = 'daytona'),
  deleted_at                 timestamptz,
  active_turn_id             text,
  active_assistant_message_id text,
  conversation_revision      bigint      not null default 0,
  turn_checkpoint            integer     not null default -1,
  active_turn_started_at     timestamptz,
  message_count              integer     not null default 0
);

create index sessions_user_id_updated_at_idx
  on public.sessions (user_id, updated_at desc)
  where deleted_at is null;

create index sessions_active_turn_id_idx
  on public.sessions (active_turn_id)
  where active_turn_id is not null;

alter table public.sessions enable row level security;

create policy "sessions_select_own"
  on public.sessions for select
  using (auth.uid() = user_id and deleted_at is null);

create policy "sessions_insert_own"
  on public.sessions for insert
  with check (auth.uid() = user_id);

create policy "sessions_update_own"
  on public.sessions for update
  using (auth.uid() = user_id);

create policy "sessions_delete_own"
  on public.sessions for delete
  using (auth.uid() = user_id);

create or replace function public.set_sessions_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger sessions_updated_at
  before update on public.sessions
  for each row execute function public.set_sessions_updated_at();

-- ---------------------------------------------------------------------------
-- session_messages
-- ---------------------------------------------------------------------------
create table public.session_messages (
  session_id text        not null references public.sessions (id) on delete cascade,
  message_id text        not null,
  position   integer     not null,
  role       text        not null check (role in ('user', 'assistant', 'system')),
  message    jsonb       not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (session_id, message_id),
  constraint session_messages_position_nonneg check (position >= 0)
);

create unique index session_messages_session_position_uidx
  on public.session_messages (session_id, position);

create index session_messages_session_id_idx
  on public.session_messages (session_id);

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
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger session_messages_updated_at
  before update on public.session_messages
  for each row execute function public.set_session_messages_updated_at();

-- ---------------------------------------------------------------------------
-- session_app_test_status
-- ---------------------------------------------------------------------------
create table public.session_app_test_status (
  session_id text        primary key references public.sessions (id) on delete cascade,
  user_id    uuid        not null references auth.users (id) on delete cascade,
  status     jsonb       not null default '{"status": "idle"}'::jsonb,
  updated_at timestamptz not null default now()
);

create index session_app_test_status_user_id_idx
  on public.session_app_test_status (user_id);

alter table public.session_app_test_status enable row level security;

create policy "session_app_test_status_select_own"
  on public.session_app_test_status for select
  using (auth.uid() = user_id);

create policy "session_app_test_status_insert_own"
  on public.session_app_test_status for insert
  with check (auth.uid() = user_id);

create policy "session_app_test_status_update_own"
  on public.session_app_test_status for update
  using (auth.uid() = user_id);

create policy "session_app_test_status_delete_own"
  on public.session_app_test_status for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- session_daytona_runtime
-- ---------------------------------------------------------------------------
create table public.session_daytona_runtime (
  session_id        text        primary key references public.sessions (id) on delete cascade,
  user_id           uuid        references auth.users (id) on delete cascade,
  revision          integer     not null default 0,
  generation        integer     not null default 0,
  desired           text        not null,
  observed          text        not null,
  sandbox_id        text,
  dev_session_name  text,
  preview_url       text,
  preview_port      integer,
  last_error        text,
  last_observed_at  timestamptz,
  lease_owner       text,
  lease_expires_at  timestamptz,
  clear_next_cache  boolean     not null default false,
  updated_at        timestamptz not null default now(),
  dev_cmd_id        text
);

create index session_daytona_runtime_user_id_idx
  on public.session_daytona_runtime (user_id);

create index session_daytona_runtime_lease_expires_at_idx
  on public.session_daytona_runtime (lease_expires_at);

alter table public.session_daytona_runtime enable row level security;

create policy "session_daytona_runtime_select_own"
  on public.session_daytona_runtime for select
  using (auth.uid() = user_id);

create policy "session_daytona_runtime_insert_own"
  on public.session_daytona_runtime for insert
  with check (auth.uid() = user_id);

create policy "session_daytona_runtime_update_own"
  on public.session_daytona_runtime for update
  using (auth.uid() = user_id);

create policy "session_daytona_runtime_delete_own"
  on public.session_daytona_runtime for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- session_runtime_projection
-- ---------------------------------------------------------------------------
create table public.session_runtime_projection (
  session_id text        primary key references public.sessions (id) on delete cascade,
  user_id    uuid        not null references auth.users (id) on delete cascade,
  version    integer     not null default 0,
  projection jsonb       not null,
  updated_at timestamptz not null default now()
);

create index session_runtime_projection_user_id_idx
  on public.session_runtime_projection (user_id);

alter table public.session_runtime_projection enable row level security;

create policy "session_runtime_projection_select_own"
  on public.session_runtime_projection for select
  using (auth.uid() = user_id);

create policy "session_runtime_projection_insert_own"
  on public.session_runtime_projection for insert
  with check (auth.uid() = user_id);

create policy "session_runtime_projection_update_own"
  on public.session_runtime_projection for update
  using (auth.uid() = user_id);

create policy "session_runtime_projection_delete_own"
  on public.session_runtime_projection for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- session_git_repositories / session_git_sync_tasks
-- ---------------------------------------------------------------------------
create table public.session_git_repositories (
  session_id text        primary key references public.sessions (id) on delete cascade,
  user_id    uuid        not null references auth.users (id) on delete cascade,
  repository jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index session_git_repositories_user_id_idx
  on public.session_git_repositories (user_id);

alter table public.session_git_repositories enable row level security;

create policy "session_git_repositories_select_own"
  on public.session_git_repositories for select
  using (auth.uid() = user_id);

create policy "session_git_repositories_insert_own"
  on public.session_git_repositories for insert
  with check (auth.uid() = user_id);

create policy "session_git_repositories_update_own"
  on public.session_git_repositories for update
  using (auth.uid() = user_id);

create policy "session_git_repositories_delete_own"
  on public.session_git_repositories for delete
  using (auth.uid() = user_id);

create table public.session_git_sync_tasks (
  session_id text        not null references public.sessions (id) on delete cascade,
  run_id     text        not null,
  user_id    uuid        not null references auth.users (id) on delete cascade,
  task       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (session_id, run_id)
);

create index session_git_sync_tasks_user_id_idx
  on public.session_git_sync_tasks (user_id);

create index session_git_sync_tasks_session_status_idx
  on public.session_git_sync_tasks (session_id, ((task->>'status')));

alter table public.session_git_sync_tasks enable row level security;

create policy "session_git_sync_tasks_select_own"
  on public.session_git_sync_tasks for select
  using (auth.uid() = user_id);

create policy "session_git_sync_tasks_insert_own"
  on public.session_git_sync_tasks for insert
  with check (auth.uid() = user_id);

create policy "session_git_sync_tasks_update_own"
  on public.session_git_sync_tasks for update
  using (auth.uid() = user_id);

create policy "session_git_sync_tasks_delete_own"
  on public.session_git_sync_tasks for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- user_github_app_installations
-- ---------------------------------------------------------------------------
create table public.user_github_app_installations (
  user_id           uuid        primary key references auth.users (id) on delete cascade,
  installation_id   bigint      not null unique,
  github_account_id bigint      not null,
  github_login      text        not null,
  updated_at        timestamptz not null default now()
);

alter table public.user_github_app_installations enable row level security;

create policy "user_github_app_installations_select_own"
  on public.user_github_app_installations for select
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- CAS RPCs (service_role / security definer)
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
