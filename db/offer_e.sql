-- Offer e (Nov 21 2026): free 3-day trial, then $49 a year. Allow flow 'e' and make it the only offer on.
alter table public.flow_events drop constraint if exists flow_events_flow_check;
alter table public.flow_events add constraint flow_events_flow_check check (flow = any (array['a','b','c','d','e']));
alter table public.purchases drop constraint if exists purchases_flow_check;
alter table public.purchases add constraint purchases_flow_check check (flow = any (array['a','b','c','d','e']));
alter table public.memberships drop constraint if exists memberships_flow_check;
alter table public.memberships add constraint memberships_flow_check check (flow = any (array['a','b','c','d','e']));
