-- New and updated sessions must use the production Daytona + Freestyle path.
-- Keep the constraint NOT VALID so legacy local rows remain readable for
-- administrative cleanup without pretending they have a Freestyle repository.

alter table public.sessions
  alter column sandbox_mode set default 'daytona';

alter table public.sessions
  drop constraint if exists sessions_sandbox_mode_check;

alter table public.sessions
  add constraint sessions_sandbox_mode_check
  check (sandbox_mode = 'daytona') not valid;
