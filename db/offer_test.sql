-- Offer test (Nov 21 2026): up to four offers, each switchable in /admin > Settings > Offer test.
--   a = old flow A (choice page: $7.99 first month membership or $49.99 filing fee)
--   b = $2 for a 7-day trial, then $49.99 a year
--   c = free 7-day trial, then $49.99 a year
--   d = free 3-day trial, then $4.99 a week (plan 1w)
-- Also: traffic source and device type on every flow event, the flow session id on purchases,
-- and admin_report(), which the /admin Funnel page reads with date, offer, source and device filters.

alter table public.flow_events drop constraint if exists flow_events_flow_check;
alter table public.flow_events add constraint flow_events_flow_check check (flow = any (array['a','b','c','d']));
alter table public.purchases drop constraint if exists purchases_flow_check;
alter table public.purchases add constraint purchases_flow_check check (flow = any (array['a','b','c','d']));
alter table public.memberships drop constraint if exists memberships_flow_check;
alter table public.memberships add constraint memberships_flow_check check (flow = any (array['a','b','c','d']));
alter table public.memberships drop constraint if exists memberships_plan_check;
alter table public.memberships add constraint memberships_plan_check check (plan = any (array['1m','3m','6m','1y','1w']));

alter table public.flow_events add column if not exists source text;   -- meta | google_ads | organic | other
alter table public.flow_events add column if not exists dtype text;    -- iphone | android | tablet | mac | windows | other
alter table public.purchases add column if not exists sid text;        -- claim flow session id (flow_events.sid)
create index if not exists purchases_sid_idx on public.purchases (sid);
create index if not exists flow_events_created_idx on public.flow_events (created_at);

insert into public.app_settings (key, value, updated_by, updated_at)
values ('offer_test', '{"a": false, "b": true, "c": true, "d": true}'::jsonb, 'setup', now())
on conflict (key) do nothing;

create or replace function public.admin_report(p_from timestamptz, p_to timestamptz, p_flow text default null, p_source text default null, p_dtype text default null)
returns json language sql stable security definer set search_path to '' as $$
with ev as (
  select e.* from public.flow_events e where e.created_at >= p_from and e.created_at < p_to
),
ses as (
  select e.sid,
    (array_agg(e.flow order by e.created_at desc))[1] as flow,
    coalesce((array_agg(e.source order by e.created_at) filter (where e.source is not null))[1], 'unknown') as source,
    coalesce((array_agg(e.dtype order by e.created_at) filter (where e.dtype is not null))[1], 'unknown') as dtype,
    (min(e.created_at) at time zone 'America/Los_Angeles')::date as day,
    bool_or(e.step in ('pay', 'trial')) as offer
  from ev e group by e.sid
),
fs as (
  select * from ses s
  where (p_flow is null or s.flow = p_flow) and (p_source is null or s.source = p_source) and (p_dtype is null or s.dtype = p_dtype)
),
buy as (
  select u.kind, u.amount_cents,
    coalesce(fs.flow, u.flow) as bflow, coalesce(fs.source, 'unknown') as bsource, coalesce(fs.dtype, 'unknown') as bdtype,
    coalesce(fs.day, (u.created_at at time zone 'America/Los_Angeles')::date) as bday,
    m.trial_ends_at, m.status as mstatus, m.updated_at as mupd
  from public.purchases u
  left join fs on fs.sid = u.sid
  left join public.memberships m on u.stripe_subscription is not null and m.stripe_subscription = u.stripe_subscription
  where fs.sid is not null
     or (u.sid is null and p_source is null and p_dtype is null and u.created_at >= p_from and u.created_at < p_to and (p_flow is null or u.flow = p_flow))
),
dims as (
  select 'flow'::text as dim, s.flow as k, s.offer from fs s
  union all select 'source', s.source, s.offer from fs s
  union all select 'dtype', s.dtype, s.offer from fs s
  union all select 'day', s.day::text, s.offer from fs s
),
agg as (
  select d.dim, d.k, count(*) as visitors, count(*) filter (where d.offer) as reached_offer from dims d group by 1, 2
),
bx as (
  select 'flow'::text as dim, b.bflow as k, b.* from buy b
  union all select 'source', b.bsource, b.* from buy b
  union all select 'dtype', b.bdtype, b.* from buy b
  union all select 'day', b.bday::text, b.* from buy b
),
bagg as (
  select x.dim, x.k, count(*) as buyers, coalesce(sum(x.amount_cents), 0) as revenue_cents,
    count(*) filter (where x.kind = 'member') as members, count(*) filter (where x.kind = 'fee') as fee_buyers,
    count(*) filter (where x.trial_ends_at > now() and x.mstatus in ('active', 'test')) as in_trial,
    count(*) filter (where x.trial_ends_at is not null and ((x.mstatus = 'cancelling' and x.trial_ends_at > now()) or (x.mstatus = 'ended' and x.mupd <= x.trial_ends_at + interval '1 hour'))) as trial_cancelled,
    count(*) filter (where x.trial_ends_at <= now() and x.mstatus in ('active', 'cancelling', 'past_due')) as trial_converted
  from bx x group by 1, 2
)
select json_build_object(
  'steps', (select coalesce(json_agg(t order by t.idx, t.visitors desc), '[]'::json) from (
      select e.step, min(e.step_index) as idx, count(distinct e.sid) as visitors from ev e join fs on fs.sid = e.sid group by e.step) t),
  'rows', (select coalesce(json_agg(r), '[]'::json) from (
      select coalesce(a.dim, b.dim) as dim, coalesce(a.k, b.k) as k, coalesce(a.visitors, 0) as visitors, coalesce(a.reached_offer, 0) as reached_offer,
        coalesce(b.buyers, 0) as buyers, coalesce(b.members, 0) as members, coalesce(b.fee_buyers, 0) as fee_buyers, coalesce(b.revenue_cents, 0) as revenue_cents,
        coalesce(b.in_trial, 0) as in_trial, coalesce(b.trial_cancelled, 0) as trial_cancelled, coalesce(b.trial_converted, 0) as trial_converted
      from agg a full join bagg b on a.dim = b.dim and a.k = b.k) r)
);
$$;
revoke all on function public.admin_report(timestamptz, timestamptz, text, text, text) from public, anon, authenticated;
grant execute on function public.admin_report(timestamptz, timestamptz, text, text, text) to service_role;
