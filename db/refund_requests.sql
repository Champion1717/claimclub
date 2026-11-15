-- Refund requests a member adds by hand on the Claim a refund page (Nov 14 2026).
-- Members only: insert needs an active (or cancelling) membership. Staff work them from /admin.
create table if not exists public.refund_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  company text not null check (char_length(company) between 2 and 80),
  amount numeric(10,2) check (amount is null or (amount > 0 and amount < 100000)),
  what text not null check (char_length(what) between 3 and 500),
  status text not null default 'requested' check (status in ('requested', 'replied', 'refunded', 'denied', 'removed')),
  admin_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists refund_requests_user on public.refund_requests (user_id, created_at desc);
alter table public.refund_requests enable row level security;

create or replace function public.is_active_member(p_uid uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m where m.user_id = p_uid and m.kind = 'member' and m.status in ('active', 'cancelling', 'test'));
$$;
revoke all on function public.is_active_member(uuid) from public;
grant execute on function public.is_active_member(uuid) to authenticated;

drop policy if exists "own refund requests" on public.refund_requests;
create policy "own refund requests" on public.refund_requests for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "members add refund requests" on public.refund_requests;
create policy "members add refund requests" on public.refund_requests for insert to authenticated
  with check ((select auth.uid()) = user_id and status = 'requested' and admin_note is null and public.is_active_member((select auth.uid())));

drop trigger if exists refund_requests_touch on public.refund_requests;
create trigger refund_requests_touch before update on public.refund_requests for each row execute function public.touch_updated_at();
