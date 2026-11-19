-- Migration form_scans (Nov 19 2026): CAPTCHA scan results per claim form, written by bot/scan.js through /api/admin.
-- gate = the form asks "Do you have a Notice ID?" first; captcha_notice / captcha_no_notice are the two paths after it.
-- captcha = true when any path a member could take shows a CAPTCHA. Server only (no member access).
create table if not exists public.form_scans (
  settlement_id text primary key,
  form_url text,
  scanned_at timestamptz not null default now(),
  worker text,
  gate boolean not null default false,
  captcha_start boolean,
  captcha_notice boolean,
  captcha_no_notice boolean,
  captcha boolean not null default false,
  kinds text[] default '{}',
  note text,
  error text
);
alter table public.form_scans enable row level security;
revoke all on public.form_scans from anon, authenticated;
