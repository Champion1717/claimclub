-- Pricing test (Nov 16 2026): flow A (current offer) vs flow B ($2 for a 7-day trial, then $49 a year).
alter table public.flow_events add column if not exists flow text not null default 'a' check (flow in ('a','b'));
alter table public.purchases   add column if not exists flow text not null default 'a' check (flow in ('a','b'));
alter table public.memberships add column if not exists flow text not null default 'a' check (flow in ('a','b'));
alter table public.memberships add column if not exists trial_ends_at timestamptz;
alter table public.memberships drop constraint if exists memberships_plan_check;
alter table public.memberships add constraint memberships_plan_check check (plan = any (array['1m','3m','6m','1y']));
create index if not exists flow_events_flow_created on public.flow_events (flow, created_at);

drop function if exists public.admin_funnel(integer);
create or replace function public.admin_funnel(p_days integer default 30, p_flow text default null)
 returns table(step text, step_index integer, visitors bigint)
 language sql stable security definer set search_path to ''
as $$
  select e.step, min(e.step_index)::integer, count(distinct e.sid)
  from public.flow_events e
  where e.created_at > now() - make_interval(days => p_days) and (p_flow is null or e.flow = p_flow)
  group by e.step
  order by min(e.step_index);
$$;

-- One row per flow: visitors, reached the offer page, buyers, revenue, and how flow B's trials are doing.
create or replace function public.admin_offer_test(p_days integer default 30)
 returns table(flow text, visitors bigint, reached_offer bigint, buyers bigint, members bigint, fee_buyers bigint, revenue_cents bigint,
               in_trial bigint, trial_cancelled bigint, trial_converted bigint)
 language sql stable security definer set search_path to ''
as $$
  with f(flow) as (values ('a'), ('b')),
  since as (select now() - make_interval(days => p_days) as t)
  select f.flow,
    (select count(distinct e.sid) from public.flow_events e, since where e.flow = f.flow and e.created_at > since.t),
    (select count(distinct e.sid) from public.flow_events e, since where e.flow = f.flow and e.created_at > since.t and e.step in ('pay','trial')),
    (select count(*) from public.purchases u, since where u.flow = f.flow and u.created_at > since.t),
    (select count(*) from public.purchases u, since where u.flow = f.flow and u.created_at > since.t and u.kind = 'member'),
    (select count(*) from public.purchases u, since where u.flow = f.flow and u.created_at > since.t and u.kind = 'fee'),
    (select coalesce(sum(u.amount_cents), 0) from public.purchases u, since where u.flow = f.flow and u.created_at > since.t),
    (select count(*) from public.memberships m, since where m.flow = f.flow and m.trial_ends_at > now() and m.status in ('active','test') and m.started_at > since.t),
    (select count(*) from public.memberships m, since where m.flow = f.flow and m.trial_ends_at is not null and m.started_at > since.t
       and (m.status = 'cancelling' and m.trial_ends_at > now() or m.status = 'ended' and m.updated_at <= m.trial_ends_at + interval '1 hour')),
    (select count(*) from public.memberships m, since where m.flow = f.flow and m.trial_ends_at <= now() and m.status in ('active','cancelling','past_due') and m.started_at > since.t)
  from f order by f.flow;
$$;
revoke all on function public.admin_funnel(integer, text) from public, anon, authenticated;
revoke all on function public.admin_offer_test(integer) from public, anon, authenticated;
grant execute on function public.admin_funnel(integer, text) to service_role;
grant execute on function public.admin_offer_test(integer) to service_role;
