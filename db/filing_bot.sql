-- Filing bot (Nov 19 2026). One row per bot attempt at a claim. Server only: no member or anon access.
create table if not exists public.bot_runs (
  id bigserial primary key,
  claim_id bigint not null references public.claims(id) on delete cascade,
  settlement_id text,
  profile text,
  mode text not null default 'dry' check (mode in ('dry', 'submit')),
  status text not null default 'running' check (status in ('running', 'filled', 'approved', 'submitted', 'needs_va', 'failed', 'cancelled')),
  confirmation text,
  error text,
  log jsonb not null default '[]'::jsonb,
  shots jsonb not null default '[]'::jsonb,
  worker text,
  approved_by text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists bot_runs_claim on public.bot_runs (claim_id, started_at desc);
create index if not exists bot_runs_status on public.bot_runs (status);
alter table public.bot_runs enable row level security;

-- Screenshots the bot takes on every page, private.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bot-shots', 'bot-shots', false, 5242880, array['image/png', 'image/jpeg'])
on conflict (id) do nothing;

-- Bot switch, shown in /admin > Settings. mode: off | dry (fill, stop before submit, staff approve) | submit.
insert into public.app_settings (key, value, updated_by)
values ('filing_bot', '{"mode":"dry","profiles":["angeion"]}'::jsonb, 'setup')
on conflict (key) do nothing;
