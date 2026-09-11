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

async function loadDistributors() {
    const { data, error } = await supabaseAdmin
        .from('distributors')
        .select('id, name, slug, custom_domain, settings, is_active, is_default')
        .eq('is_active', true);
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
        next();
    } catch (err) {
        console.error('Distributor resolution failed:', err);
        res.status(503).json({ error: 'This service is temporarily unavailable.' });
    }
}

module.exports = { resolveDistributor, invalidateDistributorCache, getCache };
