-- Nov 25 2026: Flow C test C = offer l ($2 for a 3-day trial, then $49 a year, plan 1y).
alter table flow_events drop constraint if exists flow_events_flow_check;
alter table flow_events add constraint flow_events_flow_check check (flow = any (array['a','b','c','d','e','f','g','h','i','j','k','l']));
alter table purchases drop constraint if exists purchases_flow_check;
alter table purchases add constraint purchases_flow_check check (flow = any (array['a','b','c','d','e','f','g','h','i','j','k','l']));
alter table memberships drop constraint if exists memberships_flow_check;
alter table memberships add constraint memberships_flow_check check (flow = any (array['a','b','c','d','e','f','g','h','i','j','k','l']));
