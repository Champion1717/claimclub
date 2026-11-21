-- Offer f (Nov 21 2026): free 3-day trial, then $19.99 a month (plan '1mt').
alter table public.flow_events drop constraint if exists flow_events_flow_check;
alter table public.flow_events add constraint flow_events_flow_check check (flow = any (array['a','b','c','d','e','f']));
alter table public.purchases drop constraint if exists purchases_flow_check;
alter table public.purchases add constraint purchases_flow_check check (flow = any (array['a','b','c','d','e','f']));
alter table public.memberships drop constraint if exists memberships_flow_check;
alter table public.memberships add constraint memberships_flow_check check (flow = any (array['a','b','c','d','e','f']));
alter table public.memberships drop constraint if exists memberships_plan_check;
alter table public.memberships add constraint memberships_plan_check check (plan = any (array['1m','3m','6m','1y','1w','1mt']));
