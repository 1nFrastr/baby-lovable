-- Chat history and lifecycle now live exclusively on `sessions`.

update public.session_runtime_projection
set
  projection = projection - 'run',
  version = version + 1,
  updated_at = now()
where projection ? 'run';

drop table if exists public.session_drafts;
