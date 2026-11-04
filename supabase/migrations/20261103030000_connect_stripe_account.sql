-- Pin Connect-issued runtime credentials to the verified Stripe account.
-- A same-mode key for another account must not reuse this app's webhook state.
alter table public.session_integrations
  add column stripe_account_id text
    check (stripe_account_id is null or stripe_account_id ~ '^acct_[A-Za-z0-9]+$');
