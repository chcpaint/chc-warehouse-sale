/**
 * utils/scheduler.js
 *
 * The thing that makes refinishAI work when nobody is looking at it.
 *
 * Everything the module does on a schedule — today just the low-stock digest —
 * runs here, inside the app process, on a timer. There is no external cron, no
 * service token and no new public endpoint.
 *
 * WHY IN-PROCESS RATHER THAN AN EXTERNAL CRON
 *
 * The alternative was a GitHub Action calling an HTTPS endpoint with a shared
 * secret. That means a long-lived credential in CI, and a route on the public
 * internet whose whole job is to make the server send email — a thing worth
 * attacking. Running it in the process that already holds the database
 * connection removes both. The trade is that the work only happens while the
 * app is up, which for a web app that must be up anyway is not much of a trade.
 *
 * MORE THAN ONE INSTANCE
 *
 * Railway can run several copies. Two things stop that turning into duplicate
 * email:
 *
 *  1. `scheduler_runs` has a unique key on (job, run_key). Every instance tries
 *     to insert the claim; exactly one wins and the losers stop. This is a
 *     lock built out of a constraint the database already enforces — no Redis,
 *     no leader election, nothing to run.
 *  2. The alert layer fingerprints its own content and suppresses a repeat.
 *     Belt and braces, because the failure being defended against — a customer
 *     receiving the same email twice — is the kind that erodes trust in every
 *     other email the system sends.
 *
 * TIME
 *
 * Digests go out in the morning *where the shop is*, not where the server is.
 * Railway runs UTC; a fixed UTC hour would land mid-afternoon for an Ontario
 * shop half the year, because the offset moves with daylight saving. The local
 * hour is resolved through Intl with the company's own time zone.
 */

const { supabaseAdmin } = require('./supabase');
const { moduleSettings } = require('./modules');
const { runLowStockDigest } = require('./inventory-alerts');

/** How often to wake up and check whether anything is due. */
const TICK_MS = 10 * 60 * 1000;               // 10 minutes

/** Give the app time to finish booting before the first tick. */
const FIRST_TICK_DELAY_MS = 60 * 1000;

/** Default local hour for the digest when a company has not chosen one. */
const DEFAULT_DIGEST_HOUR = 7;

/**
 * How many local hours after the target the digest may still go out.
 *
 * The first version fired only during the target hour itself, which had a
 * narrow but silent failure: with a tick every 10 minutes and a 60-second
 * startup delay, a deploy or restart late in that hour could push the first
 * tick past it. The day would then be skipped with nothing to show for it, and
 * a shop would simply not be told about its low stock — the exact failure this
 * job exists to prevent.
 *
 * A catch-up window closes it. The claim already guarantees once per company
 * per local day, so widening the window cannot produce a second email; it only
 * gives a restarted process a chance to do the work it missed. It is bounded
 * rather than open-ended because a "low stock this morning" digest arriving at
 * midnight is worse than one arriving late morning.
 */
const DIGEST_CATCHUP_HOURS = 3;

/**
 * Should a digest targeted at `target` go out during local hour `hour`?
 *
 * Pure and exported so it can be checked at all 24 hours against all 24
 * targets, rather than only at whatever hour the test suite happens to run.
 * A schedule that is only exercised at one time of day is a schedule nobody
 * has really tested.
 *
 * @returns {{due: boolean, late: boolean}}
 */
function digestDue(hour, target) {
    const windowEnd = Math.min(target + DIGEST_CATCHUP_HOURS, 24);
    const due = hour >= target && hour < windowEnd;
    return { due, late: due && hour !== target };
}

/** Fallback zone for a company with none recorded. */
const DEFAULT_TZ = 'America/Toronto';

let timer = null;
let running = false;
const stats = { started_at: null, ticks: 0, last_tick_at: null, last_error: null, jobs: {} };

// ============================================================
// TIME
// ============================================================

/**
 * The local hour and calendar date in a given zone, right now.
 * Falls back to UTC rather than throwing if the zone is unrecognised — a typo
 * in one company's settings must not stop every other company's digest.
 */
function localNow(timeZone) {
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone, hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit'
        }).formatToParts(new Date());

        const get = t => parts.find(p => p.type === t)?.value;
        // 'en-CA' with hour12:false renders midnight as 24; normalise it.
        const hour = Number(get('hour')) % 24;
        return { date: `${get('year')}-${get('month')}-${get('day')}`, hour };
    } catch (err) {
        const now = new Date();
        return { date: now.toISOString().slice(0, 10), hour: now.getUTCHours() };
    }
}

// ============================================================
// THE CLAIM
// ============================================================

/**
 * Try to become the instance that runs `job` for `runKey`.
 *
 * Returns true exactly once across every instance, for every run key, forever.
 * The uniqueness is the database's, not ours.
 */
async function claim(job, runKey, detail = null) {
    const { error } = await supabaseAdmin
        .from('scheduler_runs')
        .insert({ job, run_key: runKey, detail });

    if (!error) return true;

    // 23505 = unique_violation: somebody else already has it. Anything else is
    // a real problem and should be visible rather than silently skipping work.
    if (error.code === '23505' || /duplicate key/i.test(error.message || '')) return false;

    console.error(`Scheduler: could not claim ${job}/${runKey}:`, error.message);
    return false;
}

/** Record the outcome so an operator can see what happened without log-diving. */
async function finish(job, runKey, result) {
    try {
        await supabaseAdmin
            .from('scheduler_runs')
            .update({ finished_at: new Date().toISOString(), result })
            .eq('job', job)
            .eq('run_key', runKey);
    } catch (err) {
        console.error('Scheduler: failed to record run outcome:', err.message);
    }
}

// ============================================================
// JOBS
// ============================================================

/**
 * Send each company's low-stock digest, once, at its own local hour.
 *
 * A company is considered every tick and skipped cheaply unless the local hour
 * matches; the claim then makes sure it happens once even if several instances
 * or several ticks agree that it is time.
 */
async function lowStockDigestJob() {
    const { data: companies, error } = await supabaseAdmin
        .from('companies')
        .select('id, name, slug, settings, timezone, is_active')
        .eq('is_active', true);

    if (error) throw error;

    // `caught_up` counts digests that went out later than their target hour.
    // Persistently non-zero means the process is restarting around that time
    // and is worth looking at, so it is recorded rather than hidden.
    const outcome = { considered: 0, due: 0, sent: 0, skipped: 0, failed: 0, caught_up: 0 };

    for (const company of companies || []) {
        const settings = moduleSettings(company.settings, 'inventory');
        if (!settings.enabled) continue;

        outcome.considered += 1;

        const zone = company.timezone || DEFAULT_TZ;
        const { date, hour } = localNow(zone);
        const target = Number.isInteger(settings.digest_hour) ? settings.digest_hour : DEFAULT_DIGEST_HOUR;

        const when = digestDue(hour, target);
        if (!when.due) continue;
        outcome.due += 1;
        if (when.late) outcome.caught_up += 1;

        // One run per company per local day.
        const runKey = `low_stock:${company.id}:${date}`;
        if (!await claim('low_stock_digest', runKey, { company: company.name, zone, hour })) {
            outcome.skipped += 1;
            continue;
        }

        try {
            const result = await runLowStockDigest({
                companyId: company.id,
                settings,
                storeUrl: company.slug ? `${publicBase()}/store/${company.slug}` : null
            });

            if (result.sent) outcome.sent += 1; else outcome.skipped += 1;
            await finish('low_stock_digest', runKey, result);
        } catch (err) {
            outcome.failed += 1;
            console.error(`Scheduler: digest failed for ${company.name}:`, err.message);
            await finish('low_stock_digest', runKey, { sent: false, error: err.message });
        }
    }

    return outcome;
}

/** Where the emails should point people back to. */
function publicBase() {
    return (process.env.PUBLIC_BASE_URL || 'https://chcsale.com').replace(/\/+$/, '');
}

const JOBS = {
    low_stock_digest: lowStockDigestJob
};

// ============================================================
// THE LOOP
// ============================================================

async function tick() {
    // A tick that overruns must not have a second one started on top of it.
    if (running) return;
    running = true;
    stats.ticks += 1;
    stats.last_tick_at = new Date().toISOString();

    try {
        for (const [name, job] of Object.entries(JOBS)) {
            try {
                const result = await job();
                stats.jobs[name] = { at: stats.last_tick_at, result };
            } catch (err) {
                stats.jobs[name] = { at: stats.last_tick_at, error: err.message };
                console.error(`Scheduler: job ${name} threw:`, err.message);
            }
        }
        stats.last_error = null;
    } catch (err) {
        stats.last_error = err.message;
        console.error('Scheduler tick failed:', err.message);
    } finally {
        running = false;
    }
}

/**
 * Start the scheduler. Safe to call more than once.
 *
 * Off by default in test and whenever SCHEDULER_ENABLED is explicitly false, so
 * that running the suite — or a local copy pointed at the production database —
 * never sends a customer an email.
 */
function start() {
    if (timer) return { started: false, reason: 'already_running' };

    if (process.env.NODE_ENV === 'test' || process.env.SCHEDULER_ENABLED === 'false') {
        return { started: false, reason: 'disabled' };
    }

    stats.started_at = new Date().toISOString();
    timer = setTimeout(function loop() {
        tick().finally(() => {
            if (timer) timer = setTimeout(loop, TICK_MS);
        });
    }, FIRST_TICK_DELAY_MS);

    // Never hold the process open on account of the scheduler.
    if (typeof timer.unref === 'function') timer.unref();

    console.log(`Scheduler: started (tick every ${TICK_MS / 60000} min, digest default ${DEFAULT_DIGEST_HOUR}:00 local, ${DIGEST_CATCHUP_HOURS}h catch-up)`);
    return { started: true };
}

function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
    return { stopped: true };
}

function status() {
    return { running: Boolean(timer), tick_ms: TICK_MS, ...stats };
}

module.exports = {
    start, stop, status, tick,
    localNow, claim, lowStockDigestJob, digestDue,
    TICK_MS, DEFAULT_DIGEST_HOUR, DEFAULT_TZ, DIGEST_CATCHUP_HOURS
};
