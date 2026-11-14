-- Filing, proof of authorization, funnel tracking and admin access (Nov 14 2026).
-- Applied as Supabase migration "filing_admin". Safe to run more than once.

-- 5. Claim statuses: members can only request filing; staff move claims through the rest.
alter table public.claims drop constraint if exists claims_status_check;
alter table public.claims add constraint claims_status_check
  check (status in ('ready', 'requested', 'needs_info', 'filed', 'review', 'approved', 'paid', 'denied', 'removed'));
alter table public.claims add column if not exists requested_at timestamptz;
alter table public.claims add column if not exists member_note text;
alter table public.claims add column if not exists admin_note text;
alter table public.claims add column if not exists paid_amount_cents integer;
alter table public.claims add column if not exists paid_at timestamptz;
create index if not exists claims_status_idx on public.claims (status);

-- Members (browser) may only set ready, requested or removed. Everything else comes from the server.
create or replace function public.guard_claim_status() returns trigger language plpgsql set search_path = '' as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then return new; end if;
  if tg_op = 'INSERT' then
    if new.status not in ('ready', 'requested') then new.status := 'ready'; end if;
  elsif new.status is distinct from old.status and (new.status not in ('ready', 'requested', 'removed') or old.status not in ('ready', 'requested', 'removed')) then
    new.status := old.status;
  end if;
  if new.status = 'requested' and new.requested_at is null then new.requested_at := now(); end if;
  if tg_op = 'UPDATE' then
    new.admin_note := old.admin_note; new.paid_amount_cents := old.paid_amount_cents; new.paid_at := old.paid_at;
    new.claim_ref := old.claim_ref; new.filed_at := old.filed_at;
  else
    new.admin_note := null; new.paid_amount_cents := null; new.paid_at := null; new.claim_ref := null; new.filed_at := null;
  end if;
  return new;
end $$;
drop trigger if exists claims_guard on public.claims;
create trigger claims_guard before insert or update on public.claims for each row execute function public.guard_claim_status();

-- 6. Claim history: every status change, with who made it. Used for the audit trail and emails.
create table if not exists public.claim_events (
  id bigint generated always as identity primary key,
  claim_id bigint references public.claims (id) on delete cascade,
  user_id uuid references auth.users (id) on delete cascade,
  settlement_id text,
  status text not null,
  claim_ref text,
  note text,
  actor text not null default 'member',
  emailed boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists claim_events_claim_idx on public.claim_events (claim_id);
alter table public.claim_events enable row level security;
drop policy if exists "own claim events read" on public.claim_events;
create policy "own claim events read" on public.claim_events for select using (auth.uid() = user_id);

create or replace function public.log_claim_status() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.claim_events (claim_id, user_id, settlement_id, status, claim_ref, actor)
    values (new.id, new.user_id, new.settlement_id, new.status, new.claim_ref, case when coalesce(auth.role(), '') = 'service_role' then 'staff' else 'member' end);
  end if;
  return new;
end $$;
drop trigger if exists claims_log on public.claims;
create trigger claims_log after insert or update on public.claims for each row execute function public.log_claim_status();

-- 7. Signed authorizations: the proof that a member asked us to file each claim for them.
--    Written by /api/sign at the moment they sign (before they have an account), with the server's
--    timestamp, IP and browser, and linked to their account by email when they sign up.
create table if not exists public.authorizations (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users (id) on delete set null,
  email text not null,
  settlement_id text not null,
  settlement_title text,
  signer_name text not null,
  signature_text text not null,
  method text not null default 'single' check (method in ('single', 'bulk')),
  details jsonb not null default '{}'::jsonb,
  answers jsonb not null default '[]'::jsonb,
  statements jsonb not null default '{}'::jsonb,
  agreement_version text,
  lang text,
  client_signed_at timestamptz,
  ip text,
  user_agent text,
  page text,
  record_hash text,
  created_at timestamptz not null default now()
);
create index if not exists authorizations_email_idx on public.authorizations (lower(email));
create index if not exists authorizations_user_idx on public.authorizations (user_id);
alter table public.authorizations enable row level security;
drop policy if exists "own authorizations read" on public.authorizations;
create policy "own authorizations read" on public.authorizations for select using (auth.uid() = user_id);

-- 8. Funnel events: one row each time an anonymous visitor reaches a step of the claim flow.
create table if not exists public.flow_events (
  id bigint generated always as identity primary key,
  sid text not null,
  step text not null,
  step_index integer,
  device text,
  lang text,
  offer text,
  created_at timestamptz not null default now()
);
create index if not exists flow_events_time_idx on public.flow_events (created_at);
create index if not exists flow_events_sid_idx on public.flow_events (sid);
alter table public.flow_events enable row level security;

-- 9. Emails we send members, for support and audit.
create table if not exists public.email_log (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users (id) on delete set null,
  to_email text not null,
  kind text not null,
  subject text,
  provider_id text,
  error text,
  created_at timestamptz not null default now()
);
alter table public.email_log enable row level security;

-- 10. Admins: who can open /admin. Add a row per staff account.
create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'owner',
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;

-- Link everything made before signup to the new account.
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email) on conflict (id) do nothing;
  update public.purchases set user_id = new.id where user_id is null and lower(email) = lower(new.email);
  update public.authorizations set user_id = new.id where user_id is null and lower(email) = lower(new.email);
  return new;
end $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- Admin reporting helpers (server only).
create or replace function public.admin_funnel(p_days integer default 30)
returns table (step text, step_index integer, visitors bigint)
language sql stable security definer set search_path = '' as $$
  select e.step, min(e.step_index)::integer, count(distinct e.sid)
  from public.flow_events e
  where e.created_at > now() - make_interval(days => p_days)
  group by e.step
  order by min(e.step_index);
$$;
create or replace function public.admin_daily(p_days integer default 30)
returns table (day date, visitors bigint, signups bigint, orders bigint, revenue_cents bigint)
language sql stable security definer set search_path = '' as $$
  with d as (select generate_series((now() - make_interval(days => p_days - 1))::date, now()::date, interval '1 day')::date as day)
  select d.day,
    (select count(distinct sid) from public.flow_events f where f.created_at::date = d.day),
    (select count(*) from public.profiles p where p.created_at::date = d.day),
    (select count(*) from public.purchases u where u.created_at::date = d.day),
    (select coalesce(sum(amount_cents), 0) from public.purchases u where u.created_at::date = d.day)
  from d order by d.day;
$$;
revoke all on function public.admin_funnel(integer) from public, anon, authenticated;
revoke all on function public.admin_daily(integer) from public, anon, authenticated;
grant execute on function public.admin_funnel(integer) to service_role;
grant execute on function public.admin_daily(integer) to service_role;
revoke all on function public.guard_claim_status() from public, anon, authenticated;
revoke all on function public.log_claim_status() from public, anon, authenticated;

-- 11. Feature switches set from /admin > Settings (migration "app_settings"). Read by /api/config.
create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
insert into public.app_settings (key, value, updated_by) values ('bank_connect', 'false'::jsonb, 'launch default') on conflict (key) do nothing;
