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

test('early warning: the database is checked hourly for memory, swap, disk and connections', () => {
    const { parseMetrics, evaluate } = require('../scripts/ops/db-resources');
    const healthy = parseMetrics(`
# HELP node_memory_MemTotal_bytes total
node_memory_MemTotal_bytes{service_type="db"} 1.92e+09
node_memory_MemAvailable_bytes{service_type="db"} 1.4e+09
node_memory_SwapTotal_bytes 1.07e+09
node_memory_SwapFree_bytes 1.07e+09
node_filesystem_size_bytes{device="/dev/nvme1n1",fstype="ext4",mountpoint="/data"} 8.5e+09
node_filesystem_avail_bytes{device="/dev/nvme1n1",fstype="ext4",mountpoint="/data"} 7e+09
node_filesystem_size_bytes{device="tmpfs",fstype="tmpfs",mountpoint="/run"} 1e+12
pg_settings_max_connections 90
pg_stat_database_num_backends{datname="postgres"} 17
`);
    const ok = evaluate(healthy);
    assert.equal(ok.warnings.length, 0, ok.warnings.join('; '));
    assert.ok(ok.readings.find(r => r.label === 'Disk space used').value.startsWith('18%'), 'the /data disk, not tmpfs');

    // 18 Nov 2026: 0.5 GB of memory and half a gigabyte of swap, all day.
    const squeezed = parseMetrics(`
node_memory_MemTotal_bytes 5.0e+08
node_memory_MemAvailable_bytes 3.0e+07
node_memory_SwapTotal_bytes 1.07e+09
node_memory_SwapFree_bytes 5.0e+08
pg_settings_max_connections 60
pg_stat_database_num_backends{datname="postgres"} 55
disk_io_budget_balance_ratio 0.2
`);
    const bad = evaluate(squeezed);
    for (const what of ['Memory available', 'Swap in use', 'Database connections', 'Disk IO balance']) {
        assert.ok(bad.warnings.some(w => w.startsWith(what)), what);
    }
    const wf = read('.github/workflows/watchdog.yml');
    assert.match(wf, /node scripts\/ops\/db-resources\.js/);
    assert.match(wf, /cron: '41 \* \* \* \*'/);
});
