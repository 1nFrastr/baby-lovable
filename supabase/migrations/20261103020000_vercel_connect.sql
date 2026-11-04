-- Connect holds provider grants. These columns contain references, never tokens.
alter table public.session_integrations
  drop constraint session_integrations_supabase_link_method_check,
  add constraint session_integrations_supabase_link_method_check
    check (supabase_link_method is null or supabase_link_method in ('connect', 'oauth', 'manual')),
  add column supabase_connect_connector text,
  add column stripe_connect_connector text,
  add column stripe_connect_subject text
    check (stripe_connect_subject in ('user', 'app'));

-- An app-scoped Stripe credential is dedicated to exactly one generated app.
-- User-scoped connectors can be shared: the host derives independent app subjects.
create unique index session_integrations_stripe_app_connector_key
  on public.session_integrations (stripe_connect_connector)
  where stripe_connect_subject = 'app' and stripe_connect_connector is not null;

-- Keep the service-only grants and existing session/owner composite FK unchanged.
-- Legacy OAuth ciphertext is retained for rollback, but no longer used by the host.
