-- Flow C plans (Nov 22 2026): flow 'i' (/demo/flow-c only), plans c1 ($19.99/mo), c3 ($44.97 per 3 months), c6 ($59.94 per 6 months).
alter table public.flow_events drop constraint if exists flow_events_flow_check;
alter table public.flow_events add constraint flow_events_flow_check check (flow = any (array['a','b','c','d','e','f','g','h','i']));
alter table public.purchases drop constraint if exists purchases_flow_check;
alter table public.purchases add constraint purchases_flow_check check (flow = any (array['a','b','c','d','e','f','g','h','i']));
alter table public.memberships drop constraint if exists memberships_flow_check;
alter table public.memberships add constraint memberships_flow_check check (flow = any (array['a','b','c','d','e','f','g','h','i']));
alter table public.memberships drop constraint if exists memberships_plan_check;
alter table public.memberships add constraint memberships_plan_check check (plan = any (array['1m','3m','6m','1y','1w','1mt','std','fast','pri','c1','c3','c6']));
