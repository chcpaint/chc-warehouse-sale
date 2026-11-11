/**
 * utils/tenant.js
 *
 * Resolves which distributor a request belongs to from its Host header, and
 * attaches it as req.distributor = { id, slug, name, custom_domain, settings }.
 *
 * Three ways a host can resolve, tried in order:
 *   1. An exact match on a distributor's custom_domain (chcsale.com -> CHC,
 *      permanently, per Adam -- CHC keeps this domain for its clients even
 *      after a separate platform domain exists for onboarding others).
 *   2. A subdomain of PLATFORM_DOMAIN (env var, unset until that domain is
 *      chosen) matched against a distributor's slug: <slug>.PLATFORM_DOMAIN.
 *   3. Neither matches (local dev, Railway's own *.up.railway.app domain, or
 *      simply because only one distributor exists yet) -> the single
 *      "default" distributor. Exactly one distributor row may have
 *      is_default = true (enforced by a partial unique index); CHC is that
 *      row today. This is what keeps every existing chcsale.com request
 *      working unchanged the moment this code deploys, before any DNS or
 *      onboarding work happens.
 *
 * Small in-memory cache (the table changes rarely, requests do not) rather
 * than a Supabase round trip on every single request.
 */

const { supabaseAdmin } = require('./supabase');

const CACHE_TTL_MS = 60 * 1000;
let cache = { at: 0, byDomain: new Map(), bySlug: new Map(), byId: new Map(), defaultDistributor: null };

function normalizeHost(hostHeader) {
    return String(hostHeader || '').split(':')[0].trim().toLowerCase();
}

const BASE_COLS = 'id, name, slug, custom_domain, settings, is_active, is_default';
const LICENCE_COLS = ', short_name, support_email, country, licence_status, trial_ends_on, max_companies';

async function loadDistributors() {
    // Licence columns arrive with migration 066; before it runs, carry on without them.
    let { data, error } = await supabaseAdmin.from('distributors').select(BASE_COLS + LICENCE_COLS).eq('is_active', true);
    if (error && /column|schema cache/i.test(error.message || '')) {
        ({ data, error } = await supabaseAdmin.from('distributors').select(BASE_COLS).eq('is_active', true));
    }
    if (error) throw error;

    const byDomain = new Map();
    const bySlug = new Map();
    const byId = new Map();
    let defaultDistributor = null;
    for (const d of data || []) {
        byId.set(d.id, d);
        bySlug.set(d.slug, d);
        if (d.custom_domain) byDomain.set(String(d.custom_domain).toLowerCase(), d);
        if (d.is_default) defaultDistributor = d;
    }
    cache = { at: Date.now(), byDomain, bySlug, byId, defaultDistributor };
    return cache;
}

async function getCache() {
    if (Date.now() - cache.at > CACHE_TTL_MS) await loadDistributors();
    return cache;
}

/** Clears the cache immediately -- call after creating/editing a distributor. */
function invalidateDistributorCache() {
    cache = { at: 0, byDomain: new Map(), bySlug: new Map(), byId: new Map(), defaultDistributor: null };
}

/**
 * Is this distributor's licence in force? The default distributor (CHC) is
 * never blocked. A suspended or cancelled licence, or a trial past its end
 * date, stops that distributor's console, shops and kiosks until it is
 * reactivated from the platform console. Returns null or { code, message }.
 */
function licenceBlock(d, today = new Date().toISOString().slice(0, 10)) {
    if (!d || d.is_default) return null;
    const status = d.licence_status || 'active';
    if (status === 'suspended' || status === 'cancelled') {
        return { code: 'licence_inactive', message: 'This service is paused for this account. Please contact refinishAI.' };
    }
    if (status === 'trial' && d.trial_ends_on && String(d.trial_ends_on) < today) {
        return { code: 'trial_ended', message: 'The trial for this account has ended. Please contact refinishAI to continue.' };
    }
    return null;
}

// Always reachable, whatever the licence: health checks and the public help page's facts.
const LICENCE_FREE_PATHS = [/^\/api\/health/, /^\/api\/help\//];

/**
 * Express middleware. Always sets req.distributor to something -- there is
 * no "unresolved" state in production, by design, so downstream code never
 * has to handle a missing tenant on a real request.
 */
async function resolveDistributor(req, res, next) {
    try {
        const c = await getCache();
        const host = normalizeHost(req.headers.host);
        const platformDomain = (process.env.PLATFORM_DOMAIN || '').toLowerCase();

        let distributor = c.byDomain.get(host);

        if (!distributor && platformDomain && host.endsWith(`.${platformDomain}`)) {
            const sub = host.slice(0, -(`.${platformDomain}`.length));
            if (sub && !sub.includes('.')) distributor = c.bySlug.get(sub);
        }

        if (!distributor) distributor = c.defaultDistributor;

        if (!distributor) {
            // Only reachable if the default-distributor row was deleted or
            // deactivated -- refuse rather than silently mixing tenants.
            return res.status(503).json({ error: 'This service is temporarily unavailable.' });
        }

        req.distributor = distributor;
        const block = licenceBlock(distributor);
        if (block && !LICENCE_FREE_PATHS.some(re => re.test(req.originalUrl || req.url || ''))) {
            return res.status(402).json({ error: block.message, code: block.code });
        }
        next();
    } catch (err) {
        console.error('Distributor resolution failed:', err);
        res.status(503).json({ error: 'This service is temporarily unavailable.' });
    }
}

/**
 * The web address a distributor's people use: its own domain, else its
 * subdomain of PLATFORM_DOMAIN, else the app's main address. Invitation and
 * password links must use it, because a sign-in is only accepted on the
 * account's own distributor's address.
 */
function appBaseUrl(d) {
    const fallback = (process.env.APP_URL || process.env.PUBLIC_URL || 'https://chcsale.com').replace(/\/$/, '');
    if (!d || d.is_default) return fallback;
    if (d.custom_domain) return `https://${String(d.custom_domain).toLowerCase()}`;
    const pd = (process.env.PLATFORM_DOMAIN || '').toLowerCase();
    if (pd && d.slug) return `https://${d.slug}.${pd}`;
    return fallback;
}
async function appBaseUrlForId(distributorId) {
    if (!distributorId) return appBaseUrl(null);
    try { const c = await getCache(); return appBaseUrl(c.byId.get(distributorId)); } catch (_) { return appBaseUrl(null); }
}

module.exports = { resolveDistributor, invalidateDistributorCache, getCache, licenceBlock, appBaseUrl, appBaseUrlForId };
