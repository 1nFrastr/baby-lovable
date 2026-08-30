-- Local-only seed for CLI / headless runs.
-- Applied on `supabase db reset` (and first `supabase start` when migrations run).
-- Do NOT rely on this UUID in linked remote / production projects.

-- Fixed local auth user → set BABY_LOVABLE_DEV_USER_ID to this value in .env.local
-- Email:  dev@localhost.local
-- Password: password (Studio Auth / email sign-in only; CLI uses service role + this id)

create extension if not exists pgcrypto;

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  recovery_token,
  email_change_token_new,
  email_change
)
values (
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-1111-1111-111111111111',
  'authenticated',
  'authenticated',
  'dev@localhost.local',
  crypt('password', gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"name":"Local Dev"}'::jsonb,
  now(),
  now(),
  '',
  '',
  '',
  ''
)
on conflict (id) do nothing;

insert into auth.identities (
  id,
  user_id,
  identity_data,
  provider,
  provider_id,
  last_sign_in_at,
  created_at,
  updated_at
)
values (
  '11111111-1111-1111-1111-111111111111',
  '11111111-1111-1111-1111-111111111111',
  jsonb_build_object(
    'sub', '11111111-1111-1111-1111-111111111111',
    'email', 'dev@localhost.local',
    'email_verified', true
  ),
  'email',
  '11111111-1111-1111-1111-111111111111',
  now(),
  now(),
  now()
)
on conflict (id) do nothing;
