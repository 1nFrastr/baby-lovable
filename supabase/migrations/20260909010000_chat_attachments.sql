-- Chat attachments: private Storage bucket + metadata rows.
-- Message JSON stores `attachment://<id>` only; bytes live in Storage.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-attachments',
  'chat-attachments',
  false,
  2097152,
  array[
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'application/pdf',
    'text/plain',
    'text/markdown',
    'text/csv',
    'text/html',
    'text/xml',
    'application/json',
    'application/xml'
  ]
)
on conflict (id) do nothing;

create table public.session_attachments (
  id           text        primary key,
  session_id   text        not null references public.sessions (id) on delete cascade,
  user_id      uuid        not null references auth.users (id) on delete cascade,
  message_id   text,
  storage_path text        not null unique,
  media_type   text        not null,
  filename     text,
  byte_size    integer     not null check (byte_size >= 0),
  created_at   timestamptz not null default now(),
  dropped_at   timestamptz
);

create index session_attachments_session_id_idx
  on public.session_attachments (session_id)
  where dropped_at is null;

create index session_attachments_session_message_idx
  on public.session_attachments (session_id, message_id)
  where dropped_at is null and message_id is not null;

alter table public.session_attachments enable row level security;

create policy "session_attachments_select_own"
  on public.session_attachments for select
  using (auth.uid() = user_id);

-- Bytes are served through the host API (service role). Authenticated
-- clients may only read objects in their own user-id prefix.
create policy "chat_attachments_select_own"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'chat-attachments'
    and split_part(name, '/', 1) = auth.uid()::text
  );
