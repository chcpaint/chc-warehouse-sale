-- 046_location_orderer_names.sql
-- A shop that signs in with the shared access code can have a fixed list of the
-- people who may place its orders. At checkout the contact name becomes a
-- drop-down of those names (the person still types their own email), so every
-- order carries a real, consistently spelled name instead of free text.
--
-- Empty (the default) changes nothing: the name stays a typed field, exactly as
-- today. Safe to run more than once.

alter table public.company_locations
  add column if not exists orderer_names text[] not null default '{}';

comment on column public.company_locations.orderer_names is
  'Names offered in the checkout "who is ordering" drop-down for this location. Empty = free-text name.';
