-- Nov 15 2026: filing from the dashboard, proof files and "Action needed" replies.
alter table public.claims add column if not exists member_replied_at timestamptz;

create table if not exists public.claim_files (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  settlement_id text not null,
  path text not null unique,
  name text not null,
  size integer,
  mime text,
  created_at timestamptz not null default now()
);
create index if not exists claim_files_user_idx on public.claim_files (user_id, settlement_id);
alter table public.claim_files enable row level security;
drop policy if exists "own claim files read" on public.claim_files;
create policy "own claim files read" on public.claim_files for select using (auth.uid() = user_id);

-- Private bucket for proof. Members upload into their own folder (<user id>/...); staff read through short-lived links.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('claim-files', 'claim-files', false, 10485760, array['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists "claim files upload own folder" on storage.objects;
create policy "claim files upload own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'claim-files' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "claim files read own folder" on storage.objects;
create policy "claim files read own folder" on storage.objects for select to authenticated
  using (bucket_id = 'claim-files' and (storage.foldername(name))[1] = auth.uid()::text);

-- A member can only put a claim in the filing queue if a signed authorization for it is on file.
create or replace function public.guard_claim_status()
 returns trigger language plpgsql set search_path to '' as $function$
declare signed boolean;
begin
  if coalesce(auth.role(), '') = 'service_role' then return new; end if;
  if tg_op = 'INSERT' then
    if new.status not in ('ready', 'requested') then new.status := 'ready'; end if;
  elsif new.status is distinct from old.status and (new.status not in ('ready', 'requested', 'removed') or old.status not in ('ready', 'requested', 'removed')) then
    new.status := old.status;
  end if;
  if new.status = 'requested' and (tg_op = 'INSERT' or old.status is distinct from 'requested') then
    select exists (select 1 from public.authorizations a where a.settlement_id = new.settlement_id
      and (a.user_id = new.user_id or lower(a.email) = lower((select u.email from auth.users u where u.id = new.user_id)))) into signed;
    if not signed then new.status := case when tg_op = 'INSERT' then 'ready' else old.status end; end if;
  end if;
  if new.status = 'requested' and new.requested_at is null then new.requested_at := now(); end if;
  if tg_op = 'UPDATE' then
    new.admin_note := old.admin_note; new.paid_amount_cents := old.paid_amount_cents; new.paid_at := old.paid_at;
    new.claim_ref := old.claim_ref; new.filed_at := old.filed_at; new.member_replied_at := old.member_replied_at;
  else
    new.admin_note := null; new.paid_amount_cents := null; new.paid_at := null; new.claim_ref := null; new.filed_at := null; new.member_replied_at := null;
  end if;
  return new;
end $function$;

-- Migration membership_past_due (Nov 15 2026): a declined renewal marks the membership past_due until the card is fixed.
alter table public.memberships drop constraint memberships_status_check;
alter table public.memberships add constraint memberships_status_check check (status = any (array['active','cancelling','past_due','ended','test']));
alter table public.memberships add column if not exists payment_failed_at timestamptz;
