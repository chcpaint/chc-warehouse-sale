-- 015 — close the Supabase advisor findings on the four legacy backup tables.
--
-- These are point-in-time snapshots taken during earlier migrations (June/July
-- 2026). They hold real Assured order and product rows. Nothing in the
-- application reads them, but they were created with RLS off, so they were the
-- only public tables in the project without it — and the one thing that
-- contradicted the data-protection slide in the customer deck.
--
-- Same posture as every other table here: RLS ON with NO policy. PostgREST
-- (anon / authenticated) therefore sees nothing at all; the service role used by
-- the Node server bypasses RLS and is unaffected. Grants are revoked as well so
-- the tables are closed at two independent levels rather than one.

alter table public.orders_backup_assured_20260615    enable row level security;
alter table public.products_category_backup_20260615 enable row level security;
alter table public.products_backup_assured_20260715  enable row level security;
alter table public.products_backup_removed_20260721  enable row level security;

revoke all on public.orders_backup_assured_20260615    from anon, authenticated;
revoke all on public.products_category_backup_20260615 from anon, authenticated;
revoke all on public.products_backup_assured_20260715  from anon, authenticated;
revoke all on public.products_backup_removed_20260721  from anon, authenticated;

comment on table public.orders_backup_assured_20260615    is 'Legacy snapshot 2026-06-15. RLS on, no policy, service-role only. Safe to drop once the June order migration is considered settled.';
comment on table public.products_category_backup_20260615 is 'Legacy snapshot 2026-06-15. RLS on, no policy, service-role only. Safe to drop once the category migration is considered settled.';
comment on table public.products_backup_assured_20260715  is 'Legacy snapshot 2026-07-15. RLS on, no policy, service-role only. Safe to drop once the July catalogue migration is considered settled.';
comment on table public.products_backup_removed_20260721  is 'Legacy snapshot 2026-07-21. RLS on, no policy, service-role only. Retains products removed from the catalogue; keep until the removals are confirmed correct.';
