-- 068_uptime_monitor_light.sql
--
-- Fixes the outage of 18 Nov 2026.
--
-- Migration 064's monitor fetched four full pages every minute from inside the
-- database (the admin console page alone is ~720 KB) and pg_net keeps every
-- response for hours. That wrote roughly 1 MB a minute, around the clock, and
-- used up the database's disk-activity allowance until it stopped answering.
--
-- From now on the database checks ONE small address, /api/health/ready, which
-- answers only when the app can reach the database -- so it still proves the
-- whole service is up. It checks every 2 minutes, deletes each answer as soon as
-- it has read it, and clears any backlog. The hourly GitHub watchdog still
-- checks from outside.
--
-- Safe to run twice.

-- 1. Stop the old every-minute job first.
do $$ begin
  perform cron.unschedule('refinishai-uptime');
exception when others then null;
end $$;

-- 2. Only the small health address is checked; the full pages are not fetched.
update public.uptime_targets set enabled = false
 where url not like '%/api/health/ready';
update public.uptime_targets set enabled = true
 where url like '%/api/health/ready';

-- Nothing still waiting on the old pages.
delete from monitor.pending p
 using public.uptime_targets t
 where t.id = p.target_id and not t.enabled;

-- 3. Clear the stored responses (they are only ever read once).
do $$ begin
  delete from net._http_response;
exception when others then raise notice 'Could not clear net._http_response: %', sqlerrm;
end $$;

-- 4. The tick, unchanged except that it deletes each answer once read.
create or replace function monitor.tick()
returns void
language plpgsql
security definer
set search_path = monitor, public, extensions, pg_catalog
as $$
declare
  s     public.uptime_settings%rowtype;
  r     record;
  t     record;
  inc   public.uptime_incidents%rowtype;
  fails int;
  rid   bigint;
begin
  select * into s from public.uptime_settings where id = 1;

  -- 1. Answers that have arrived, and requests that never answered.
  for r in
    select p.request_id, p.target_id, p.sent_at, tg.expect_status, tg.expect_text,
           h.status_code, left(h.content, 2000) as content, h.timed_out, h.error_msg, h.created
      from monitor.pending p
      join public.uptime_targets tg on tg.id = p.target_id
      left join net._http_response h on h.id = p.request_id
     where h.id is not null or p.sent_at < now() - interval '5 minutes'
  loop
    insert into public.uptime_checks (target_id, checked_at, ok, status_code, ms, error)
    values (
      r.target_id,
      r.sent_at,
      r.status_code is not null and r.status_code = r.expect_status
        and coalesce(r.timed_out, false) = false and r.error_msg is null
        and (r.expect_text is null or position(r.expect_text in coalesce(r.content, '')) > 0),
      r.status_code,
      case when r.created is not null then greatest(0, (extract(epoch from (r.created - r.sent_at)) * 1000)::int) end,
      case
        when r.created is null then 'No answer within 5 minutes'
        when coalesce(r.timed_out, false) then 'Timed out'
        when r.error_msg is not null then left(r.error_msg, 300)
        when r.status_code is distinct from r.expect_status then 'HTTP ' || coalesce(r.status_code::text, '?')
        when r.expect_text is not null and position(r.expect_text in coalesce(r.content, '')) = 0 then 'Page did not say ' || r.expect_text
      end);
    delete from monitor.pending where request_id = r.request_id;
    -- Read once; never keep it.
    begin
      delete from net._http_response where id = r.request_id;
    exception when others then null;
    end;
  end loop;

  -- 2. Incidents: open after `fail_threshold` failures in a row, close on the first success.
  for t in select * from public.uptime_targets where enabled loop
    select * into inc from public.uptime_incidents where target_id = t.id and resolved_at is null order by started_at desc limit 1;
    select count(*) into fails from (
      select ok from public.uptime_checks where target_id = t.id order by checked_at desc limit s.fail_threshold
    ) last where not ok;
    if inc.id is null and fails >= s.fail_threshold
       and (select count(*) from (select 1 from public.uptime_checks where target_id = t.id order by checked_at desc limit s.fail_threshold) n) >= s.fail_threshold then
      insert into public.uptime_incidents (target_id, started_at, first_error, alerted_at)
      select t.id, min(c.checked_at), (array_agg(c.error order by c.checked_at))[1], now()
        from (select checked_at, error from public.uptime_checks where target_id = t.id order by checked_at desc limit s.fail_threshold) c;
      perform monitor.send_alert(
        'DOWN: ' || t.name,
        t.name || ' (' || t.url || ') has failed ' || s.fail_threshold || ' checks in a row.' || E'\n' ||
        'Last error: ' || coalesce((select error from public.uptime_checks where target_id = t.id order by checked_at desc limit 1), 'unknown') || E'\n' ||
        'Checked from Supabase every 2 minutes. You will get another email when it recovers.');
    elsif inc.id is not null and exists (
      select 1 from (select ok from public.uptime_checks where target_id = t.id order by checked_at desc limit 1) l where l.ok) then
      update public.uptime_incidents set resolved_at = now(), recovery_alerted_at = now() where id = inc.id;
      perform monitor.send_alert(
        'RECOVERED: ' || t.name,
        t.name || ' (' || t.url || ') is answering again. Down for about ' ||
        greatest(1, round(extract(epoch from (now() - inc.started_at)) / 60))::int || ' minute(s).');
    end if;
    inc := null;
  end loop;

  -- 3. This round's requests.
  for t in select * from public.uptime_targets where enabled loop
    if not exists (select 1 from monitor.pending where target_id = t.id) then
      rid := net.http_get(
        url := t.url,
        headers := jsonb_build_object('User-Agent', 'refinishAI-uptime/1.0', 'Cache-Control', 'no-cache'),
        timeout_milliseconds := s.timeout_ms);
      insert into monitor.pending (request_id, target_id) values (rid, t.id);
    end if;
  end loop;

  -- 4. History older than keep_days, and any stray stored answers, once an hour.
  if extract(minute from now()) < 2 then
    delete from public.uptime_checks where checked_at < now() - make_interval(days => s.keep_days);
    begin
      delete from net._http_response where created < now() - interval '15 minutes';
    exception when others then null;
    end;
  end if;
end;
$$;

revoke all on function monitor.tick() from public;

-- 5. Every 2 minutes.
select cron.schedule('refinishai-uptime', '*/2 * * * *', $cron$select monitor.tick()$cron$);
