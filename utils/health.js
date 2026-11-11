/**
 * utils/health.js
 *
 * Readiness: can this server actually reach the database right now?
 * /api/health stays a cheap "the process is up" answer; /api/health/ready is
 * the one an uptime monitor should watch, because a server that is running but
 * cannot reach Postgres is down for every customer.
 *
 * Reads one row from a small table. No customer data leaves; only ok/not ok and
 * how long it took.
 */
async function checkDatabase(supabase, timeoutMs = 3000) {
    const started = Date.now();
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeoutMs);
    });
    const probe = (async () => {
        try {
            const { error } = await supabase.from('distributors').select('id').limit(1);
            return error ? { ok: false, error: 'query_failed' } : { ok: true };
        } catch (_) {
            return { ok: false, error: 'unreachable' };
        }
    })();
    const result = await Promise.race([probe, timeout]);
    clearTimeout(timer);
    return { ...result, ms: Date.now() - started };
}

module.exports = { checkDatabase };
