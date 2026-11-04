-- BYO backend integrations: user Supabase OAuth + per-session Supabase / Stripe / Deploy.

-- ---------------------------------------------------------------------------
-- user_supabase_connections — Management API OAuth tokens (encrypted at rest)
-- ---------------------------------------------------------------------------
create table public.user_supabase_connections (
  user_id                  uuid        primary key references auth.users (id) on delete cascade,
  access_token_ciphertext  text        not null,
  refresh_token_ciphertext text        not null,
  expires_at               timestamptz,
  supabase_user_email      text,
  updated_at               timestamptz not null default now()
);

alter table public.user_supabase_connections enable row level security;

-- Credentials are service-only. Expose safe metadata through the host API,
-- never encrypted OAuth tokens to browser clients (including their owner).

-- ---------------------------------------------------------------------------
-- session_integrations — per-session backend bindings (secrets encrypted)
-- ---------------------------------------------------------------------------
-- A composite reference enforces session ownership even for service-role writes.
-- sessions.id is already unique, so this cannot introduce duplicate sessions.
alter table public.sessions
  add constraint sessions_id_user_id_key unique (id, user_id);

create table public.session_integrations (
  session_id                     text        primary key,
  user_id                        uuid        not null
    references auth.users (id) on delete cascade,
  constraint session_integrations_session_owner_fkey
    foreign key (session_id, user_id)
    references public.sessions (id, user_id) on delete cascade on update cascade,

  supabase_status                text        not null default 'disconnected'
    check (supabase_status in ('disconnected', 'connecting', 'linked', 'error')),
  supabase_project_ref           text,
  supabase_project_name          text,
  supabase_project_url           text,
  supabase_link_method           text
    check (supabase_link_method is null or supabase_link_method in ('oauth', 'manual')),
  supabase_secrets_ciphertext    text,
  supabase_error                 text,

  stripe_status                  text        not null default 'disconnected'
    check (stripe_status in ('disconnected', 'linked', 'error')),
  stripe_mode                    text
    check (stripe_mode is null or stripe_mode in ('test', 'live')),
  stripe_publishable_key_hint    text,
  stripe_secrets_ciphertext      text,
  stripe_error                   text,

  deploy_status                  text        not null default 'idle'
    check (deploy_status in ('idle', 'deploying', 'live', 'error')),
  deploy_provider                text
    check (deploy_provider is null or deploy_provider in ('freestyle')),
  deploy_id                      text,
  deploy_url                     text,
  deploy_error                   text,
  deploy_updated_at              timestamptz,

  updated_at                     timestamptz not null default now()
);

create index session_integrations_user_id_idx
  on public.session_integrations (user_id);

alter table public.session_integrations enable row level security;

-- No anon/authenticated policies or grants: ciphertext never leaves the service.
-- Revoke explicitly because Supabase may install default privileges for tables.
revoke all on public.user_supabase_connections from public, anon, authenticated;
revoke all on public.session_integrations from public, anon, authenticated;
grant all on public.user_supabase_connections to service_role;
grant all on public.session_integrations to service_role;
