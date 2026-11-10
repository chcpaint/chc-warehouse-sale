-- 058_rename_north7yorkmills.sql
--
-- Rename the North Seven / York Mills sign-in name (company slug) from
--   northseven-yorkmillsautomotive
-- to
--   north7yorkmills
-- (all lower case).
--
-- WHAT THIS CHANGES
--   Only companies.slug for that one company. The slug is what people type on the
--   sign-in screen and what appears in the shop's web address, so after this runs
--   they sign in as "north7yorkmills". Everything else keyed to the company
--   (orders, shops, people, prices, settings, reports) hangs off its id, so none of
--   it moves.
--
-- WHAT THIS DOES NOT TOUCH
--   Any other company, including Assured and its three-step sign-in (type
--   "assured", enter the access code, pick the shop). No access code, setting,
--   module, user, order or price is changed.
--
-- SAFETY
--   - Stops with a message, and changes nothing, unless exactly one company has
--     the old slug.
--   - Stops if the new slug is already used by another company under the same
--     distributor.
--   - Safe to re-run: once renamed, it reports that and does nothing.
--   - To undo:  update public.companies set slug = 'northseven-yorkmillsautomotive'
--                where slug = 'north7yorkmills';
--
-- AFTER RUNNING: tell the team the new sign-in name. Old bookmarks that contain
-- the old name will stop working; people (and the individual logins for Bav and
-- Kartik) now type north7yorkmills.
--
-- HOW TO RUN: paste the whole file into the Supabase SQL editor and click Run.
-- The result tabs show the company under its new name, then a shop-separation
-- check (see the end of the file).

do $$
declare
    old_slug  constant text := 'northseven-yorkmillsautomotive';
    new_slug  constant text := 'north7yorkmills';
    n_old     int;
    n_new     int;
    cid       uuid;
    dist      uuid;
begin
    select count(*) into n_old from public.companies where slug = old_slug;
    select count(*) into n_new from public.companies where slug = new_slug;

    if n_old = 0 and n_new = 1 then
        raise notice 'Already renamed: % exists and % does not. Nothing changed.', new_slug, old_slug;
        return;
    end if;
    if n_old <> 1 then
        raise exception 'Expected exactly one company with slug "%", found %. Nothing was changed.', old_slug, n_old;
    end if;

    select id, distributor_id into cid, dist from public.companies where slug = old_slug;

    if exists (select 1 from public.companies
                where slug = new_slug and distributor_id is not distinct from dist) then
        raise exception 'Another company under the same distributor already uses "%". Nothing was changed.', new_slug;
    end if;

    update public.companies set slug = new_slug, updated_at = now() where id = cid;
    raise notice 'Renamed % to %.', old_slug, new_slug;
end $$;

-- The company under its new name.
select c.id, c.name, c.slug, c.is_active,
       (select count(*) from public.company_locations l where l.company_id = c.id) as shops,
       (select count(*) from public.company_users u where u.company_id = c.id and u.is_active) as people
  from public.companies c
 where c.slug = 'north7yorkmills';

-- Shop separation check (read-only). One row per person on the account.
--   shop_lock = the shop that person is locked to in Order History and Reports.
--   "BOTH SHOPS" means that person has no shop set and sees the whole company.
select coalesce(l.name, 'BOTH SHOPS') as shop_lock,
       u.name, u.email, u.role, u.is_active
  from public.company_users u
  join public.companies c on c.id = u.company_id and c.slug = 'north7yorkmills'
  left join public.company_locations l on l.id = u.location_id
 order by (u.location_id is null), l.name, u.name;
