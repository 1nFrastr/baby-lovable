-- Keep the provider's actual Team slug for canonical project-dashboard links.
alter table public.vercel_publish_targets add column team_slug text;
drop function public.select_vercel_publish_team(text, uuid, text, text);
create function public.select_vercel_publish_team(p_session text, p_user uuid, p_team text, p_name text, p_slug text default null)
returns void language plpgsql set search_path = public as $$
begin
  perform 1 from public.sessions where id = p_session and user_id = p_user for update;
  if not found then raise exception 'publish_not_owned'; end if;
  if exists(select 1 from public.vercel_publish_jobs where session_id = p_session and active) then raise exception 'publish_busy'; end if;
  if exists(select 1 from public.vercel_publish_targets where session_id = p_session and project_id is not null and team_id <> p_team) then raise exception 'publish_target_locked'; end if;
  insert into public.vercel_publish_targets(session_id, user_id, team_id, team_name, team_slug)
    values(p_session, p_user, p_team, p_name, p_slug)
    on conflict(session_id) do update set team_id = excluded.team_id, team_name = excluded.team_name,
      team_slug = coalesce(excluded.team_slug, public.vercel_publish_targets.team_slug), updated_at = now();
end $$;
revoke all on function public.select_vercel_publish_team(text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.select_vercel_publish_team(text, uuid, text, text, text) to service_role;
