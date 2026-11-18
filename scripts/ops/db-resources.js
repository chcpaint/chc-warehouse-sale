#!/usr/bin/env node
/**
 * scripts/ops/db-resources.js -- early warning for the database running short.
 *
 * On 18 Nov 2026 the database ran out of memory, swapped to disk all day, used
 * up its disk-activity (Disk IO) allowance and stopped answering. This check
 * reads Supabase's metrics feed for the project and warns BEFORE that happens:
 *
 *   memory available   below MIN_MEM_AVAILABLE_PCT (default 15%)
 *   swap in use        above MAX_SWAP_MB          (default 256 MB)
 *   disk space used    above MAX_DISK_USED_PCT    (default 80%)
 *   connections        above MAX_CONN_PCT         (default 80%) of the maximum
 *   Disk IO balance    below MIN_IO_BALANCE_PCT   (default 40%), when Supabase publishes it
 *
 * Runs in the hourly GitHub watchdog, outside the database, so watching adds no
 * load to it. Exit code 1 = a warning (GitHub notifies the repository's
 * watchers; turn on Actions notifications in the GitHub mobile app for a push).
 * Exit code 2 = the metrics feed could not be read (also a failed run).
 *
 * Needs SUPABASE_URL and a secret key: SUPABASE_METRICS_KEY if set, otherwise
 * SUPABASE_SERVICE_ROLE_KEY. Read-only. Prints no secrets.
 */
'use strict';

const LIMITS = {
    minMemAvailablePct: Number(process.env.MIN_MEM_AVAILABLE_PCT || 15),
    maxSwapMb: Number(process.env.MAX_SWAP_MB || 256),
    maxDiskUsedPct: Number(process.env.MAX_DISK_USED_PCT || 80),
    maxConnPct: Number(process.env.MAX_CONN_PCT || 80),
    minIoBalancePct: Number(process.env.MIN_IO_BALANCE_PCT || 40)
};

/** Prometheus text format -> [{ name, labels, value }]. */
function parseMetrics(text) {
    const out = [];
    for (const raw of String(text || '').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+(\S+)/);
        if (!m) continue;
        const labels = {};
        if (m[3]) for (const p of m[3].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) labels[p[1]] = p[2];
        const value = Number(m[4]);
        if (Number.isFinite(value)) out.push({ name: m[1], labels, value });
    }
    return out;
}

const first = (rows, name, pred = () => true) => {
    const r = rows.find(x => x.name === name && pred(x.labels));
    return r ? r.value : null;
};
const sum = (rows, name) => {
    const v = rows.filter(x => x.name === name);
    return v.length ? v.reduce((s, x) => s + x.value, 0) : null;
};

/** Turn the metrics into readings and warnings. Pure. */
function evaluate(rows, limits = LIMITS) {
    const readings = [];
    const warnings = [];
    const add = (label, value, ok, limitText) => {
        readings.push({ label, value, ok, limit: limitText });
        if (ok === false) warnings.push(`${label}: ${value} (limit ${limitText})`);
    };

    const memTotal = first(rows, 'node_memory_MemTotal_bytes');
    const memAvail = first(rows, 'node_memory_MemAvailable_bytes');
    if (memTotal && memAvail !== null) {
        const pct = (memAvail / memTotal) * 100;
        add('Memory available', `${pct.toFixed(0)}% of ${(memTotal / 2 ** 30).toFixed(2)} GB`, pct >= limits.minMemAvailablePct, `at least ${limits.minMemAvailablePct}%`);
    } else add('Memory available', 'not published', null, '');

    const swapTotal = first(rows, 'node_memory_SwapTotal_bytes');
    const swapFree = first(rows, 'node_memory_SwapFree_bytes');
    if (swapTotal !== null && swapFree !== null) {
        const mb = (swapTotal - swapFree) / 2 ** 20;
        add('Swap in use', `${mb.toFixed(0)} MB`, mb <= limits.maxSwapMb, `at most ${limits.maxSwapMb} MB`);
    } else add('Swap in use', 'not published', null, '');

    // The database's data disk: /data where present, otherwise the largest real filesystem.
    const isReal = l => !/tmpfs|overlay|squashfs|devtmpfs/.test(l.fstype || '');
    const sizes = rows.filter(x => x.name === 'node_filesystem_size_bytes' && isReal(x.labels));
    const disk = sizes.find(x => x.labels.mountpoint === '/data') || sizes.sort((a, b) => b.value - a.value)[0];
    if (disk) {
        const avail = first(rows, 'node_filesystem_avail_bytes', l => l.mountpoint === disk.labels.mountpoint && l.device === disk.labels.device);
        if (avail !== null && disk.value > 0) {
            const pct = (1 - avail / disk.value) * 100;
            add('Disk space used', `${pct.toFixed(0)}% of ${(disk.value / 2 ** 30).toFixed(1)} GB`, pct <= limits.maxDiskUsedPct, `at most ${limits.maxDiskUsedPct}%`);
        }
    } else add('Disk space used', 'not published', null, '');

    const maxConn = first(rows, 'pg_settings_max_connections');
    const conns = sum(rows, 'pg_stat_database_num_backends') ?? sum(rows, 'pg_stat_activity_count');
    if (maxConn && conns !== null) {
        const pct = (conns / maxConn) * 100;
        add('Database connections', `${conns} of ${maxConn}`, pct <= limits.maxConnPct, `at most ${limits.maxConnPct}%`);
    } else add('Database connections', 'not published', null, '');

    // Disk IO allowance: published under different names over time, so match by meaning.
    const io = rows.find(x => /io_?budget|burst_?balance|io_?balance|iops_?balance|disk_?io.*(balance|budget)/i.test(x.name));
    if (io) {
        const pct = io.value <= 1 ? io.value * 100 : io.value;
        add('Disk IO balance', `${pct.toFixed(0)}%`, pct >= limits.minIoBalancePct, `at least ${limits.minIoBalancePct}%`);
    } else add('Disk IO balance', 'not in the metrics feed (watch the dashboard)', null, '');

    return { readings, warnings };
}

async function main() {
    const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const key = process.env.SUPABASE_METRICS_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) { console.error('::error::SUPABASE_URL and a secret key are needed to read database metrics.'); process.exit(2); }

    let text;
    try {
        const res = await fetch(`${url}/customer/v1/privileged/metrics`, {
            headers: { Authorization: 'Basic ' + Buffer.from(`service_role:${key}`).toString('base64') },
            signal: AbortSignal.timeout(30000)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        text = await res.text();
    } catch (err) {
        console.error(`::error::Could not read the database metrics feed (${err.message}). If this says 401, add a secret API key (sb_secret_...) as the SUPABASE_METRICS_KEY repository secret.`);
        process.exit(2);
    }

    const { readings, warnings } = evaluate(parseMetrics(text));
    const lines = ['### Database resources', '', '| Check | Now | Limit | |', '| --- | --- | --- | --- |',
        ...readings.map(r => `| ${r.label} | ${r.value} | ${r.limit || '—'} | ${r.ok === false ? '⚠️' : r.ok ? '✅' : ''} |`)];
    console.log(lines.join('\n'));
    if (process.env.GITHUB_STEP_SUMMARY) require('fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');

    if (warnings.length) {
        for (const w of warnings) console.error(`::error::Database running short: ${w}`);
        console.error('::error::Act before it stalls: Supabase > Project Settings > Compute and Disk (raise the compute size or disk), or look at Reports > Database for what is using it. See docs/OPERATIONS.md.');
        process.exit(1);
    }
}

if (require.main === module) main();
module.exports = { parseMetrics, evaluate, LIMITS };
