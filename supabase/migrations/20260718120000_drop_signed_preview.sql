-- Public Daytona preview URLs replace signed embeds.
-- Drop the signed-URL sidecar cache and expiry column on the runtime snapshot.

drop policy if exists "session_signed_preview_select_own" on public.session_signed_preview;
drop policy if exists "session_signed_preview_insert_own" on public.session_signed_preview;
drop policy if exists "session_signed_preview_update_own" on public.session_signed_preview;
drop policy if exists "session_signed_preview_delete_own" on public.session_signed_preview;

drop index if exists public.session_signed_preview_user_id_idx;

drop table if exists public.session_signed_preview;

alter table public.session_daytona_runtime
  drop column if exists preview_expires_at_ms;
