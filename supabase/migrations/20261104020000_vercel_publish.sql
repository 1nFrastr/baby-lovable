-- Production publication is Vercel-only. Freestyle remains the source store.
alter table public.session_integrations drop constraint session_integrations_deploy_provider_check;
alter table public.session_integrations add constraint session_integrations_deploy_provider_check
  check (deploy_provider is null or deploy_provider in ('freestyle', 'vercel'));

create table public.user_vercel_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  connector text not null,
  updated_at timestamptz not null default now()
);

create table public.vercel_publish_targets (
  session_id text primary key,
  user_id uuid not null,
  team_id text not null,
  team_name text not null,
  project_id text,
  project_name text,
  production_url text,
  updated_at timestamptz not null default now(),
  foreign key (session_id, user_id) references public.sessions(id, user_id) on delete cascade on update cascade
);

create table public.vercel_publish_jobs (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  user_id uuid not null,
  team_id text not null,
  project_id text,
  project_name text not null,
  repo_id text,
  source_sha text,
  phase text not null default 'pending' check (phase in (
    'pending', 'preparing', 'creating_project', 'uploading', 'submitting',
    'QUEUED', 'INITIALIZING', 'BUILDING', 'READY', 'ERROR', 'uncertain'
  )),
  active boolean not null default true,
  deployment_id text,
  production_url text,
  error_code text,
  build_logs text,
  poll_count integer not null default 0,
  workflow_run_id text,
  lease_id uuid,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (session_id, user_id) references public.sessions(id, user_id) on delete cascade on update cascade,
  check ((repo_id is null) = (source_sha is null)),
  check (source_sha is null or source_sha ~ '^[a-f0-9]{40,64}$'),
  check (phase not in ('READY', 'ERROR') or not active)
);
create unique index vercel_publish_one_active_job on public.vercel_publish_jobs(session_id) where active;
create index vercel_publish_jobs_session_created on public.vercel_publish_jobs(session_id, created_at desc);

-- Preserve existing public URLs even after the first Vercel publication.
create table public.legacy_freestyle_publications (
  session_id text primary key,
  user_id uuid not null,
  deployment_id text,
  url text,
  published_at timestamptz,
  foreign key (session_id, user_id) references public.sessions(id, user_id) on delete cascade on update cascade
);
insert into public.legacy_freestyle_publications(session_id, user_id, deployment_id, url, published_at)
  select session_id, user_id, deploy_id, deploy_url, deploy_updated_at from public.session_integrations
  where deploy_provider = 'freestyle';
-- Old uncertain Freestyle requests cannot block the new provider.
update public.session_integrations set deploy_status = 'error'
  where deploy_provider = 'freestyle' and deploy_status = 'deploying';

alter table public.user_vercel_connections enable row level security;
alter table public.vercel_publish_targets enable row level security;
alter table public.vercel_publish_jobs enable row level security;
alter table public.legacy_freestyle_publications enable row level security;
revoke all on public.user_vercel_connections, public.vercel_publish_targets, public.vercel_publish_jobs, public.legacy_freestyle_publications from public, anon, authenticated;
grant all on public.user_vercel_connections, public.vercel_publish_targets, public.vercel_publish_jobs, public.legacy_freestyle_publications to service_role;

-- Lock the app while selecting a team or reserving a job so target changes cannot
-- race publication. These functions are service-only; callers supply a verified owner.
create function public.select_vercel_publish_team(p_session text, p_user uuid, p_team text, p_name text)
returns void language plpgsql set search_path = public as $$
begin
  perform 1 from public.sessions where id = p_session and user_id = p_user for update;
  if not found then raise exception 'publish_not_owned'; end if;
  if exists(select 1 from public.vercel_publish_jobs where session_id = p_session and active) then
    raise exception 'publish_busy';
  end if;
  if exists(select 1 from public.vercel_publish_targets where session_id = p_session and project_id is not null and team_id <> p_team) then
    raise exception 'publish_target_locked';
  end if;
  insert into public.vercel_publish_targets(session_id, user_id, team_id, team_name)
    values(p_session, p_user, p_team, p_name)
    on conflict(session_id) do update set team_id = excluded.team_id, team_name = excluded.team_name, updated_at = now();
end $$;

create function public.enqueue_vercel_publish(p_session text, p_user uuid)
returns public.vercel_publish_jobs language plpgsql set search_path = public as $$
declare target public.vercel_publish_targets; job public.vercel_publish_jobs; job_id uuid := gen_random_uuid();
begin
  perform 1 from public.sessions where id = p_session and user_id = p_user for update;
  if not found then raise exception 'publish_not_owned'; end if;
  select * into job from public.vercel_publish_jobs where session_id = p_session and user_id = p_user and active;
  if found then return job; end if;
  perform 1 from public.user_vercel_connections where user_id = p_user for update;
  if not found then raise exception 'vercel_not_connected'; end if;
  if exists(select 1 from public.sessions where id = p_session and run_status in ('pending', 'running', 'cancelling')) then raise exception 'publish_busy'; end if;
  select * into target from public.vercel_publish_targets where session_id = p_session and user_id = p_user;
  if not found then raise exception 'vercel_team_required'; end if;
  insert into public.vercel_publish_jobs(id, session_id, user_id, team_id, project_id, project_name)
    values(job_id, p_session, p_user, target.team_id, target.project_id,
      coalesce(target.project_name, 'baby-' || substr(md5(p_session), 1, 24))) returning * into job;
  insert into public.session_integrations(session_id, user_id, deploy_status, deploy_provider, deploy_error, deploy_updated_at)
    values(p_session, p_user, 'deploying', 'vercel', null, now())
    on conflict(session_id) do update set deploy_status = 'deploying', deploy_provider = 'vercel', deploy_error = null, deploy_updated_at = now();
  return job;
end $$;

-- A lease fences worker updates. Mutation intent is persisted before provider
-- calls; an expired worker never repeats an uncertain POST.
create function public.claim_vercel_publish_job(p_job uuid, p_user uuid, p_lease uuid)
returns setof public.vercel_publish_jobs language sql set search_path = public as $$
  update public.vercel_publish_jobs set lease_id = p_lease, lease_until = now() + interval '4 minutes'
  where id = p_job and user_id = p_user and active and (lease_until is null or lease_until < now()) returning *;
$$;

create function public.finish_vercel_publish_job(p_job uuid, p_user uuid, p_lease uuid, p_success boolean, p_error text, p_logs text)
returns boolean language plpgsql set search_path = public as $$
declare job public.vercel_publish_jobs;
begin
  update public.vercel_publish_jobs set phase = case when p_success then 'READY' else 'ERROR' end,
    active = false, error_code = p_error, build_logs = left(p_logs, 24000), lease_id = null, lease_until = null, updated_at = now()
    where id = p_job and user_id = p_user and lease_id = p_lease and active returning * into job;
  if not found then return false; end if;
  if p_success then
    update public.vercel_publish_targets set production_url = job.production_url, updated_at = now()
      where session_id = job.session_id and user_id = p_user and project_id = job.project_id;
  end if;
  update public.session_integrations set deploy_status = case when p_success then 'live' else 'error' end,
    deploy_provider = 'vercel', deploy_id = job.deployment_id,
    deploy_url = case when p_success then job.production_url else deploy_url end,
    deploy_error = p_error, deploy_updated_at = now(), updated_at = now()
    where session_id = job.session_id and user_id = p_user;
  return true;
end $$;

create function public.bind_vercel_publish_project(p_job uuid, p_user uuid, p_lease uuid, p_project text, p_name text)
returns void language plpgsql set search_path = public as $$
declare job public.vercel_publish_jobs;
begin
  select * into job from public.vercel_publish_jobs where id = p_job and user_id = p_user and lease_id = p_lease and active for update;
  if not found then raise exception 'publish_lease_lost'; end if;
  update public.vercel_publish_targets set project_id = p_project, project_name = p_name, updated_at = now()
    where session_id = job.session_id and user_id = p_user and team_id = job.team_id and (project_id is null or project_id = p_project);
  if not found then raise exception 'publish_target_locked'; end if;
  update public.vercel_publish_jobs set project_id = p_project, project_name = p_name where id = p_job;
end $$;

create function public.disconnect_vercel_publish(p_user uuid)
returns void language plpgsql set search_path = public as $$
begin
  perform 1 from public.user_vercel_connections where user_id = p_user for update;
  if exists(select 1 from public.vercel_publish_jobs where user_id = p_user and active) then raise exception 'publish_busy'; end if;
  delete from public.user_vercel_connections where user_id = p_user;
end $$;

revoke all on function public.select_vercel_publish_team(text, uuid, text, text), public.enqueue_vercel_publish(text, uuid), public.claim_vercel_publish_job(uuid, uuid, uuid), public.finish_vercel_publish_job(uuid, uuid, uuid, boolean, text, text), public.bind_vercel_publish_project(uuid, uuid, uuid, text, text), public.disconnect_vercel_publish(uuid) from public, anon, authenticated;
grant execute on function public.select_vercel_publish_team(text, uuid, text, text), public.enqueue_vercel_publish(text, uuid), public.claim_vercel_publish_job(uuid, uuid, uuid), public.finish_vercel_publish_job(uuid, uuid, uuid, boolean, text, text), public.bind_vercel_publish_project(uuid, uuid, uuid, text, text), public.disconnect_vercel_publish(uuid) to service_role;
