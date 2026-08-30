-- UI subscribes to session_runtime_projection via postgres_changes.
alter publication supabase_realtime
  add table only public.session_runtime_projection;
