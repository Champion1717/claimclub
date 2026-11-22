-- Flow C live (Nov 22 2026): offers j (A, 1y 3-day trial) and k (B, 1mt 3-day trial) next to i (C plans); the /start page's checkout step 'offer' counts as reaching the offer.
alter table public.flow_events drop constraint if exists flow_events_flow_check;
alter table public.flow_events add constraint flow_events_flow_check check (flow = any (array['a','b','c','d','e','f','g','h','i','j','k']));
alter table public.purchases drop constraint if exists purchases_flow_check;
alter table public.purchases add constraint purchases_flow_check check (flow = any (array['a','b','c','d','e','f','g','h','i','j','k']));
alter table public.memberships drop constraint if exists memberships_flow_check;
alter table public.memberships add constraint memberships_flow_check check (flow = any (array['a','b','c','d','e','f','g','h','i','j','k']));
do $$ declare d text; begin
  d := pg_get_functiondef('public.admin_report'::regproc);
  d := replace(d, $q$e.step in ('pay', 'trial', 'tiers')$q$, $q$e.step in ('pay', 'trial', 'tiers', 'offer')$q$);
  execute d;
end $$;
