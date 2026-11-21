-- Nov 21 2026: one blanket authorization at checkout (trial offers) is stored with method 'blanket'.
alter table public.authorizations drop constraint if exists authorizations_method_check;
alter table public.authorizations add constraint authorizations_method_check check (method = any (array['single','bulk','blanket']));
