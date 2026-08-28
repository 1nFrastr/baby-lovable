-- Mid-turn assistant progress now lives in sessions.messages (authoritative
-- read model). session_drafts is no longer used for display or persistence.

drop policy if exists "session_drafts_select_own" on public.session_drafts;
drop policy if exists "session_drafts_insert_own" on public.session_drafts;
drop policy if exists "session_drafts_update_own" on public.session_drafts;
drop policy if exists "session_drafts_delete_own" on public.session_drafts;

drop index if exists public.session_drafts_user_id_idx;

drop table if exists public.session_drafts;
