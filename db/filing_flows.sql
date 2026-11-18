-- Nov 18 2026: per-claim filing flows (auto pay, we file, you file) and the case finder.

-- New claim statuses: 'auto' = nothing to file, waiting for the automatic payout; 'self' = the member is filing it themselves.
alter table public.claims drop constraint if exists claims_status_check;
alter table public.claims add constraint claims_status_check check (status = any (array['ready','requested','needs_info','filed','review','approved','paid','denied','removed','auto','self']));
-- Member progress on a claim: auto checklist ticks, guide step, confirmation number, self_sent.
alter table public.claims add column if not exists progress jsonb not null default '{}'::jsonb;
alter table public.claims add column if not exists paid_by_member boolean not null default false;

-- One filing spec per settlement: how it gets filed and what each flow shows. Server only (read through /api/filing).
create table if not exists public.settlement_filing (
  id text primary key,
  type text not null check (type in ('auto','we','self','closed')),
  filer text not null default 'va' check (filer in ('bot','va','member','none')),
  form_url text,
  admin text,
  deadline date,
  minutes integer,
  needs jsonb not null default '[]'::jsonb,
  why_self text,
  gather jsonb not null default '[]'::jsonb,
  steps jsonb not null default '[]'::jsonb,
  form_map jsonb not null default '[]'::jsonb,
  va_notes text,
  member_note text,
  confidence text,
  source text not null default 'research',
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.settlement_filing enable row level security;

-- Settlements added or changed after the site was built: new cases approved in /admin > New cases, closed ones hidden, deadlines moved.
create table if not exists public.catalog_extra (
  id text primary key,
  data jsonb not null default '{}'::jsonb,   -- full settlement record for new cases, or only the changed fields (e.g. {"dl": "2026-11-29"})
  is_new boolean not null default false,
  hidden boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.catalog_extra enable row level security;

-- What the case finder found, waiting for staff review.
create table if not exists public.case_candidates (
  id bigserial primary key,
  kind text not null default 'new' check (kind in ('new','change')),
  settlement_id text,
  title text not null,
  company text,
  url text,
  source text,
  payout text,
  deadline date,
  summary text,
  suggested_type text check (suggested_type in ('auto','we','self','closed')),
  details jsonb not null default '{}'::jsonb,
  status text not null default 'new' check (status in ('new','approved','ignored')),
  found_at timestamptz not null default now(),
  reviewed_by text,
  reviewed_at timestamptz
);
create unique index if not exists case_candidates_url_key on public.case_candidates (url) where url is not null;
create index if not exists case_candidates_status_idx on public.case_candidates (status, found_at desc);
alter table public.case_candidates enable row level security;

-- Migration filing_specs_plain (Nov 18 2026, later): plain-English case content per spec.
alter table public.settlement_filing add column if not exists about text, add column if not exists who text, add column if not exists qualify jsonb, add column if not exists notice jsonb, add column if not exists start_note text;
