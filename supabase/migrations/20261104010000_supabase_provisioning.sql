-- Reserve one provider request per app, including requests with an unknown outcome.
create unique index backend_operations_supabase_provisioning_idx
  on public.backend_operations (session_id)
  where action = 'create_supabase_project' and status <> 'failed';
