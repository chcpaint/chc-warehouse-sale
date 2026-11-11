/**
 * tests/uptime-sql.test.js -- the uptime monitor (migration 064), run for real
 * in Postgres with small stand-ins for pg_net, Vault and pg_cron.
 *
 * Needs a scratch database: TEST_PG_URL=postgres://... node --test tests/uptime-sql.test.js
 * Skipped (not failed) when TEST_PG_URL is not set, so the normal suite and CI
 * run without a database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const URL = process.env.TEST_PG_URL;
const sqlFile = fs.readFileSync(path.join(__dirname, '../migrations/064_uptime_monitor.sql'), 'utf8');

function psql(sql) {
    return execFileSync('psql', [URL, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8' }).trim();
}

const STUBS = `
drop schema if exists monitor cascade; drop schema if exists net cascade; drop schema if exists vault cascade; drop schema if exists cron cascade;
drop table if exists public.uptime_checks, public.uptime_incidents, public.uptime_targets, public.uptime_settings cascade;
create schema net;
create table net._http_response (id bigint primary key, status_code int, content_type text, headers jsonb, content text, timed_out bool, error_msg text, created timestamptz default now());
create table net.sent (id bigserial primary key, method text, url text, body jsonb, headers jsonb);
create function net.http_get(url text, params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000) returns bigint
  language sql as $$ insert into net.sent (method, url, headers) values ('GET', url, headers) returning id $$;
create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000) returns bigint
  language sql as $$ insert into net.sent (method, url, body, headers) values ('POST', url, body, headers) returning id $$;
create schema vault;
create table vault.decrypted_secrets (name text, decrypted_secret text);
create schema cron;
create table cron.job (jobid serial, jobname text, schedule text, command text);
create function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid::bigint $$;
create function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname = n returning true $$;
`;

// Part A needs the real Supabase extensions; everything else runs as written.
const PORTABLE = sqlFile.replace(/create extension if not exists pg_net[^;]*;/, '').replace(/create extension if not exists pg_cron[^;]*;/, '');

/** Answer every outstanding GET: url -> [status, content] (missing = no answer). */
function answer(map) {
    const rows = psql(`select id || '|' || url from net.sent where method = 'GET' and id not in (select id from net._http_response) and id in (select request_id from monitor.pending);`);
    for (const line of rows.split('\n').filter(Boolean)) {
        const [id, url] = line.split('|');
        const a = map[url];
        if (!a) continue;
        psql(`insert into net._http_response (id, status_code, content, timed_out, error_msg) values (${id}, ${a[0] == null ? 'null' : a[0]}, ${a[1] == null ? 'null' : `'${a[1]}'`}, ${a[2] ? 'true' : 'false'}, null);`);
    }
}
const HEALTH = 'https://chcsale.com/api/health/ready';
const allUp = { [HEALTH]: [200, '{"status":"ready"}'], 'https://chcsale.com/': [200, 'ok'], 'https://chcsale.com/admin': [200, 'ok'], 'https://chcsale.com/help': [200, 'ok'] };

test('uptime monitor: checks, incidents, alerts and recovery', { skip: !URL && 'set TEST_PG_URL to run' }, () => {
    psql(STUBS);
    psql(PORTABLE);
    psql(PORTABLE);   // safe to run twice
    assert.equal(psql(`select count(*) from cron.job where jobname = 'refinishai-uptime' and schedule = '* * * * *';`), '1');
    assert.equal(psql('select count(*) from public.uptime_targets;'), '4');
    psql(`insert into vault.decrypted_secrets values ('sendgrid_api_key', 'SG.test');`);

    // Minute 1: requests go out.
    psql('select monitor.tick();');
    assert.equal(psql(`select count(*) from monitor.pending;`), '4');

    // Minute 2: all answered fine.
    answer(allUp);
    psql('select monitor.tick();');
    assert.equal(psql('select count(*) from public.uptime_checks where ok;'), '4');

    // Minutes 3-4: health check says the database is down (503), twice.
    const down = { ...allUp, [HEALTH]: [503, '{"status":"unavailable"}'] };
    answer(down); psql('select monitor.tick();');
    assert.equal(psql('select count(*) from public.uptime_incidents;'), '0', 'one failure is not an outage');
    answer(down); psql('select monitor.tick();');
    assert.equal(psql('select count(*) from public.uptime_incidents where resolved_at is null;'), '1');
    const alert = psql(`select body->>'subject' from net.sent where method = 'POST' and url like '%sendgrid%' order by id desc limit 1;`);
    assert.match(alert, /^DOWN: Health check/);
    assert.equal(psql(`select headers->>'Authorization' from net.sent where method = 'POST' order by id desc limit 1;`), 'Bearer SG.test');
    assert.equal(psql(`select body->'personalizations'->0->'to'->0->>'email' from net.sent where method = 'POST' order by id desc limit 1;`), 'adam@chcpaint.com');
    assert.match(psql(`select error from public.uptime_checks where not ok order by id desc limit 1;`), /HTTP 503/);

    // Another failure does not send a second DOWN email.
    answer(down); psql('select monitor.tick();');
    assert.equal(psql(`select count(*) from net.sent where method = 'POST' and body->>'subject' like 'DOWN%';`), '1');

    // Recovery.
    answer(allUp); psql('select monitor.tick();');
    assert.equal(psql('select count(*) from public.uptime_incidents where resolved_at is null;'), '0');
    assert.match(psql(`select body->>'subject' from net.sent where method = 'POST' order by id desc limit 1;`), /^RECOVERED: Health check/);

    // A 200 that does not say "ready" is a failure; no answer for 3 minutes is a failure.
    answer({ ...allUp, [HEALTH]: [200, 'maintenance page'] }); psql('select monitor.tick();');
    assert.match(psql(`select error from public.uptime_checks where not ok order by id desc limit 1;`), /did not say/);
    psql(`update monitor.pending set sent_at = now() - interval '5 minutes';`);
    psql('select monitor.tick();');
    assert.match(psql(`select error from public.uptime_checks where not ok order by id desc limit 1;`), /No answer/);

    // Summary for the console.
    const pct = psql(`select uptime_pct from public.uptime_summary(24) where target_id = 1;`);
    assert.ok(Number(pct) > 0 && Number(pct) < 100, pct);

    // No key in Vault: no email is attempted, monitoring carries on.
    psql('delete from vault.decrypted_secrets;');
    psql(`update public.uptime_settings set webhook_url = 'https://hooks.example.test/x';`);
    psql(`select monitor.send_alert('t', 'b');`);
    assert.equal(psql(`select url from net.sent where method = 'POST' order by id desc limit 1;`), 'https://hooks.example.test/x');
});
