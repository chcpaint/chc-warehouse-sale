/**
 * tests/security-package.test.js -- the pieces a buyer's IT team checks first:
 * a way to report a vulnerability, browser feature limits, tested backups, and
 * an independent uptime monitor.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('security.txt is served (RFC 9116) with a contact, an expiry and a policy', () => {
    const server = read('server.js');
    assert.match(server, /app\.get\('\/\.well-known\/security\.txt'/);
    for (const f of ['Contact: mailto:', 'Expires: ', 'Policy: ', 'Canonical: ']) assert.ok(server.includes(f), f);
    assert.ok(server.indexOf("'/.well-known/security.txt'") < server.indexOf('// 404 handler'), 'registered before the catch-all');
    assert.match(read('public/help.html'), /id="report"/);
    assert.match(read('SECURITY.md'), /Reporting a vulnerability/);
});

test('Permissions-Policy limits the browser to the camera and payments on its own pages', () => {
    assert.match(read('server.js'), /Permissions-Policy', 'camera=\(self\), microphone=\(\), geolocation=\(\), payment=\(self\)/);
});

test('backups: nightly, encrypted, kept outside Supabase, restored every night', () => {
    const wf = read('.github/workflows/backup.yml');
    assert.match(wf, /cron: '17 7 \* \* \*'/);
    assert.match(wf, /--symmetric --cipher-algo AES256/);
    assert.match(wf, /restore-drill:/);
    assert.match(wf, /BACKUP_PASSPHRASE must be at least 24 characters/);
    assert.match(wf, /rest\/v1\/backup_runs/);
    const drill = read('scripts/backup/restore-drill.sh');
    assert.match(drill, /Refusing: the drill restores into a scratch database, not Supabase/);
    assert.match(drill, /--exit-on-error/);
    assert.match(read('scripts/backup/storage.js'), /Refusing path outside the backup folder/);
});

test('uptime: checked every minute from Supabase, watched hourly from GitHub', () => {
    const sql = read('migrations/064_uptime_monitor.sql');
    assert.match(sql, /cron\.schedule\('refinishai-uptime', '\* \* \* \* \*'/);
    assert.match(sql, /alter table public\.uptime_settings  enable row level security/);
    assert.match(read('.github/workflows/watchdog.yml'), /"uptime_monitor":"stale"/);
    assert.match(read('server.js'), /uptime_monitor: db\.ok \? await health\.monitorStatus/);
});
