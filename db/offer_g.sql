-- Offer G (Nov 21 2026): Standard (free), Fast ($15/mo), Priority ($30/mo). Plans std, fast, pri; flow g.
alter table public.flow_events drop constraint if exists flow_events_flow_check;
alter table public.flow_events add constraint flow_events_flow_check check (flow = any (array['a','b','c','d','e','f','g']));
alter table public.purchases drop constraint if exists purchases_flow_check;
alter table public.purchases add constraint purchases_flow_check check (flow = any (array['a','b','c','d','e','f','g']));
alter table public.memberships drop constraint if exists memberships_flow_check;
alter table public.memberships add constraint memberships_flow_check check (flow = any (array['a','b','c','d','e','f','g']));
alter table public.memberships drop constraint if exists memberships_plan_check;
alter table public.memberships add constraint memberships_plan_check check (plan = any (array['1m','3m','6m','1y','1w','1mt','std','fast','pri']));
alter table public.memberships drop constraint if exists memberships_pending_plan_check;
alter table public.memberships add constraint memberships_pending_plan_check check (pending_plan is null or pending_plan = any (array['1m','3m','6m','std','fast','pri']));
-- Claim refunds and Subscription Manager are Priority only: Standard and Fast cannot add refund requests.
create or replace function public.is_active_member(p_uid uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m where m.user_id = p_uid and m.kind = 'member' and m.status in ('active', 'cancelling', 'test') and coalesce(m.plan, '') not in ('std', 'fast'));
$$;
