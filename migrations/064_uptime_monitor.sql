-- 064_uptime_monitor.sql
--
-- A free uptime monitor that runs inside Supabase, on different infrastructure
-- from the app (Railway). Every minute it requests chcsale.com's health check
-- and key pages, records the result, and when a page fails twice in a row it
-- emails the alert list (and an optional Slack / Teams / Discord webhook);
-- it emails again when the page recovers. The CHC console shows uptime % and
-- incidents (Reports > Uptime).
--
-- Uses two Supabase extensions: pg_cron (the every-minute schedule) and pg_net
-- (outbound HTTP). Email goes through SendGrid, with the API key read from
-- Supabase Vault -- add it once, after running this file:
--
--   select vault.create_secret('<your SendGrid API key>', 'sendgrid_api_key', 'Uptime alert email');
--
-- Safe to run more than once. Touches no app data. To stop it:
--   select cron.unschedule('refinishai-uptime');

-- ===================== PART A: Supabase extensions + schedule =====================
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

-- ===================== PART B: tables and logic (portable) ========================
create schema if not exists monitor;
revoke all on schema monitor from public;

create table if not exists public.uptime_targets (
  id            serial primary key,
  name          varchar(80) not null,
  url           text not null check (url ~ '^https://'),
  expect_status int not null default 200,
  expect_text   text,
  enabled       boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (url)
);

create table if not exists public.uptime_checks (
  id          bigserial primary key,
  target_id   int not null references public.uptime_targets(id) on delete cascade,
  checked_at  timestamptz not null default now(),
  ok          boolean not null,
  status_code int,
  ms          int,
  error       text
);
create index if not exists idx_uptime_checks_target_time on public.uptime_checks (target_id, checked_at desc);
create index if not exists idx_uptime_checks_time on public.uptime_checks (checked_at desc);

create table if not exists public.uptime_incidents (
  id                 bigserial primary key,
  target_id          int not null references public.uptime_targets(id) on delete cascade,
  started_at         timestamptz not null,
  resolved_at        timestamptz,
  first_error        text,
  alerted_at         timestamptz,
  recovery_alerted_at timestamptz
);
create index if not exists idx_uptime_incidents_open on public.uptime_incidents (target_id) where resolved_at is null;

create table if not exists public.uptime_settings (
  id                 int primary key default 1 check (id = 1),
  alert_emails       text[] not null default array['adam@chcpaint.com'],
  from_email         text not null default 'promo@chcpaint.com',
  sendgrid_secret    text not null default 'sendgrid_api_key',
  webhook_url        text check (webhook_url is null or webhook_url ~ '^https://'),
  fail_threshold     int not null default 2 check (fail_threshold between 1 and 10),
  timeout_ms         int not null default 10000 check (timeout_ms between 1000 and 30000),
  keep_days          int not null default 90 check (keep_days between 7 and 400),
  updated_at         timestamptz not null default now()
);
insert into public.uptime_settings (id) values (1) on conflict (id) do nothing;

-- Requests in flight: pg_net is asynchronous, so a request sent this minute is
-- read back on the next tick.
create table if not exists monitor.pending (
  request_id bigint primary key,
  target_id  int not null references public.uptime_targets(id) on delete cascade,
  sent_at    timestamptz not null default now()
);

-- Server-only tables (the service role bypasses RLS); nothing public.
alter table public.uptime_targets   enable row level security;
alter table public.uptime_checks    enable row level security;
alter table public.uptime_incidents enable row level security;
alter table public.uptime_settings  enable row level security;

insert into public.uptime_targets (name, url, expect_status, expect_text) values
  ('Health check (app + database)', 'https://chcsale.com/api/health/ready', 200, '"ready"'),
  ('Shop sign-in page',            'https://chcsale.com/',                 200, null),
  ('CHC console',                  'https://chcsale.com/admin',            200, null),
  ('Help page',                    'https://chcsale.com/help',             200, null)
on conflict (url) do nothing;

-- One alert, to every address on the list and the webhook if set. Never raises:
-- a failed alert must not stop monitoring.
create or replace function monitor.send_alert(p_subject text, p_body text)
returns void
language plpgsql
security definer
set search_path = monitor, public, extensions, pg_catalog
as $$
declare
  s   public.uptime_settings%rowtype;
  key text;
  e   text;
begin
  select * into s from public.uptime_settings where id = 1;
  begin
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into key using s.sendgrid_secret;
  exception when others then key := null;
  end;
  if key is not null and coalesce(array_length(s.alert_emails, 1), 0) > 0 then
    foreach e in array s.alert_emails loop
      begin
        perform net.http_post(
          url := 'https://api.sendgrid.com/v3/mail/send',
          body := jsonb_build_object(
            'personalizations', jsonb_build_array(jsonb_build_object('to', jsonb_build_array(jsonb_build_object('email', e)))),
            'from', jsonb_build_object('email', s.from_email, 'name', 'refinishAI uptime'),
            'subject', p_subject,
            'content', jsonb_build_array(jsonb_build_object('type', 'text/plain', 'value', p_body))),
          headers := jsonb_build_object('Authorization', 'Bearer ' || key, 'Content-Type', 'application/json'),
          timeout_milliseconds := 10000);
      exception when others then raise warning 'uptime email to % failed: %', e, sqlerrm;
      end;
    end loop;
  end if;
  if s.webhook_url is not null then
    begin
      -- "text" for Slack / Teams-style webhooks, "content" for Discord.
      perform net.http_post(
        url := s.webhook_url,
        body := jsonb_build_object('text', p_subject || E'\n' || p_body, 'content', p_subject || E'\n' || p_body),
        headers := jsonb_build_object('Content-Type', 'application/json'),
        timeout_milliseconds := 10000);
    exception when others then raise warning 'uptime webhook failed: %', sqlerrm;
    end;
  end if;
end;
$$;

-- The every-minute job: read last minute's answers, open or close incidents,
-- send this minute's requests, tidy old history.
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
           h.status_code, h.content, h.timed_out, h.error_msg, h.created
      from monitor.pending p
      join public.uptime_targets tg on tg.id = p.target_id
      left join net._http_response h on h.id = p.request_id
     where h.id is not null or p.sent_at < now() - interval '3 minutes'
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
        when r.created is null then 'No answer within 3 minutes'
        when coalesce(r.timed_out, false) then 'Timed out'
        when r.error_msg is not null then left(r.error_msg, 300)
        when r.status_code is distinct from r.expect_status then 'HTTP ' || coalesce(r.status_code::text, '?')
        when r.expect_text is not null and position(r.expect_text in coalesce(r.content, '')) = 0 then 'Page did not say ' || r.expect_text
      end);
    delete from monitor.pending where request_id = r.request_id;
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
        'Checked from Supabase every minute. You will get another email when it recovers.');
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

  -- 3. This minute's requests.
  for t in select * from public.uptime_targets where enabled loop
    if not exists (select 1 from monitor.pending where target_id = t.id) then
      rid := net.http_get(
        url := t.url,
        headers := jsonb_build_object('User-Agent', 'refinishAI-uptime/1.0', 'Cache-Control', 'no-cache'),
        timeout_milliseconds := s.timeout_ms);
      insert into monitor.pending (request_id, target_id) values (rid, t.id);
    end if;
  end loop;

  -- 4. History older than keep_days, once an hour.
  if extract(minute from now()) = 0 then
    delete from public.uptime_checks where checked_at < now() - make_interval(days => s.keep_days);
  end if;
end;
$$;

revoke all on function monitor.tick() from public;
revoke all on function monitor.send_alert(text, text) from public;

-- Uptime % for the console: one row per target for a window.
create or replace function public.uptime_summary(p_hours int)
returns table (target_id int, checks bigint, ok_checks bigint, uptime_pct numeric, avg_ms int, last_checked timestamptz, last_ok boolean)
language sql
stable
set search_path = public, pg_catalog
as $$
  select t.id,
         count(c.id),
         count(c.id) filter (where c.ok),
         case when count(c.id) = 0 then null else round(100.0 * count(c.id) filter (where c.ok) / count(c.id), 3) end,
         avg(c.ms) filter (where c.ok)::int,
         max(c.checked_at),
         (select ok from public.uptime_checks l where l.target_id = t.id order by checked_at desc limit 1)
    from public.uptime_targets t
    left join public.uptime_checks c on c.target_id = t.id and c.checked_at >= now() - make_interval(hours => p_hours)
   group by t.id
   order by t.id;
$$;
do $$
begin
  revoke all on function public.uptime_summary(int) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.uptime_summary(int) from anon, authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.uptime_summary(int) to service_role;
  end if;
end
$$;

-- ===================== PART C: the schedule (Supabase) =====================
do $$
begin
  if exists (select 1 from cron.job where jobname = 'refinishai-uptime') then
    perform cron.unschedule('refinishai-uptime');
  end if;
  perform cron.schedule('refinishai-uptime', '* * * * *', 'select monitor.tick()');
end
$$;

-- Check (after two or three minutes):
--   select * from public.uptime_summary(1);
--   select * from public.uptime_checks order by id desc limit 10;
