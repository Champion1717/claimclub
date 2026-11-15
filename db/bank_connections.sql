-- Bank and card connections through Plaid (Nov 15 2026). Server only: row level security is on and there are no
-- policies, so only the service role (our API functions) can read or write. Members see their data through /api/plaid.
create table if not exists public.plaid_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  item_id text not null unique,
  access_token_enc text not null,
  institution_id text,
  institution_name text,
  status text not null default 'ok' check (status in ('ok', 'login_required', 'error')),
  error_code text,
  cursor text,
  synced_at timestamptz,
  env text not null default 'sandbox',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists plaid_items_user on public.plaid_items (user_id);

create table if not exists public.plaid_accounts (
  account_id text primary key,
  item_id text not null references public.plaid_items (item_id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text, mask text, type text, subtype text
);
create index if not exists plaid_accounts_user on public.plaid_accounts (user_id);

create table if not exists public.bank_transactions (
  transaction_id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  item_id text not null references public.plaid_items (item_id) on delete cascade,
  account_id text,
  date date not null,
  amount numeric(12,2) not null,
  name text,
  merchant_name text,
  descriptor text,
  category text,
  category_detail text,
  website text,
  logo_url text,
  pending boolean not null default false,
  verdict text check (verdict in ('fight', 'look', 'ok')),
  reasons jsonb not null default '[]'::jsonb,
  back numeric(12,2),
  user_choice text check (user_choice in ('fight', 'fine', 'unknown')),
  created_at timestamptz not null default now()
);
create index if not exists bank_transactions_user_date on public.bank_transactions (user_id, date desc);

create table if not exists public.bank_recurring (
  stream_id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  item_id text not null references public.plaid_items (item_id) on delete cascade,
  merchant text,
  description text,
  category text,
  frequency text,
  first_date date, last_date date, next_date date,
  last_amount numeric(12,2), average_amount numeric(12,2),
  status text,
  is_active boolean not null default true,
  user_choice text check (user_choice in ('keep', 'cancel')),
  updated_at timestamptz not null default now()
);
create index if not exists bank_recurring_user on public.bank_recurring (user_id);

alter table public.plaid_items enable row level security;
alter table public.plaid_accounts enable row level security;
alter table public.bank_transactions enable row level security;
alter table public.bank_recurring enable row level security;

-- Refund requests can now also be cancel requests, and can point at the charge or subscription they came from.
alter table public.refund_requests add column if not exists kind text not null default 'refund';
alter table public.refund_requests add column if not exists source_transaction_id text;
alter table public.refund_requests add column if not exists source_stream_id text;
do $$ begin
  alter table public.refund_requests add constraint refund_requests_kind check (kind in ('refund', 'cancel'));
exception when duplicate_object then null; end $$;

drop trigger if exists plaid_items_touch on public.plaid_items;
create trigger plaid_items_touch before update on public.plaid_items for each row execute function public.touch_updated_at();
