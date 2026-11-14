-- Claimclub database schema (Supabase / Postgres)
-- Run once in Supabase: SQL Editor > New query > paste > Run.
-- Every table uses row level security: a signed-in member can only read and change their own rows.
-- Memberships and purchases are written only by the server (Stripe webhook / API) with the service role key.

-- 1. Profiles: one row per member, keyed to their Supabase login.
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  name text,
  phone text,
  dob text,
  address text,
  state text,
  past_addresses jsonb not null default '[]'::jsonb,
  lived_here_10y boolean not null default false,
  bank_connected boolean not null default false,
  pay_default text not null default 'Check' check (pay_default in ('Direct deposit', 'PayPal', 'Check')),
  text_alerts boolean not null default true,
  email_receipts boolean not null default true,
  theme text not null default 'light' check (theme in ('light', 'dark', 'system')),
  scale text not null default 'm' check (scale in ('s', 'm', 'l')),
  authorization_signed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2. Claims: one row per settlement on a member's list.
create table if not exists public.claims (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  settlement_id text not null,
  status text not null default 'ready' check (status in ('ready', 'filed', 'review', 'approved', 'paid', 'removed')),
  source text not null default 'flow' check (source in ('flow', 'quiz', 'added')),
  answers jsonb not null default '{}'::jsonb,
  payout_method text,
  claim_ref text,
  filed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, settlement_id)
);
create index if not exists claims_user_idx on public.claims (user_id);

-- 3. Memberships: filing fee or subscription. Server-written only.
create table if not exists public.memberships (
  user_id uuid primary key references auth.users (id) on delete cascade,
  kind text not null check (kind in ('fee', 'member')),
  plan text check (plan in ('1m', '3m', '6m')),
  status text not null default 'active' check (status in ('active', 'cancelling', 'ended', 'test')),
  pending_plan text check (pending_plan in ('1m', '3m', '6m')),
  renews_at timestamptz,
  stripe_customer text,
  stripe_subscription text,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 4. Purchases: every completed Stripe checkout, by email, so a payment made before
--    the member signs in is linked to their account the first time they log in.
create table if not exists public.purchases (
  id bigint generated always as identity primary key,
  email text not null,
  user_id uuid references auth.users (id) on delete set null,
  kind text not null,
  plan text,
  amount_cents integer,
  stripe_session text unique,
  stripe_customer text,
  stripe_subscription text,
  settlement_ids text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists purchases_email_idx on public.purchases (lower(email));

-- updated_at bookkeeping
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
drop trigger if exists claims_touch on public.claims;
create trigger claims_touch before update on public.claims for each row execute function public.touch_updated_at();
drop trigger if exists memberships_touch on public.memberships;
create trigger memberships_touch before update on public.memberships for each row execute function public.touch_updated_at();

-- Create an empty profile the moment someone signs up.
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email) on conflict (id) do nothing;
  update public.purchases set user_id = new.id where user_id is null and lower(email) = lower(new.email);
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Row level security
alter table public.profiles enable row level security;
alter table public.claims enable row level security;
alter table public.memberships enable row level security;
alter table public.purchases enable row level security;

drop policy if exists "own profile read" on public.profiles;
create policy "own profile read" on public.profiles for select using (auth.uid() = id);
drop policy if exists "own profile write" on public.profiles;
create policy "own profile write" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);
drop policy if exists "own profile insert" on public.profiles;
create policy "own profile insert" on public.profiles for insert with check (auth.uid() = id);

drop policy if exists "own claims read" on public.claims;
create policy "own claims read" on public.claims for select using (auth.uid() = user_id);
drop policy if exists "own claims insert" on public.claims;
create policy "own claims insert" on public.claims for insert with check (auth.uid() = user_id);
drop policy if exists "own claims update" on public.claims;
create policy "own claims update" on public.claims for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own membership read" on public.memberships;
create policy "own membership read" on public.memberships for select using (auth.uid() = user_id);

drop policy if exists "own purchases read" on public.purchases;
create policy "own purchases read" on public.purchases for select using (auth.uid() = user_id);
-- No insert/update policies on memberships or purchases: only the service role (server) can write them.
