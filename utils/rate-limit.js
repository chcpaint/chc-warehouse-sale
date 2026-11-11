/**
 * utils/rate-limit.js
 *
 * The site-wide request limit. It used to be 100 requests per 15 minutes per IP
 * address for everything under /api. That is fine for an anonymous visitor and
 * hopeless for the admin console: one screen (kit mapping) makes a request per
 * kit line, an office of staff shares one IP, and "Too many requests" then lands
 * in the middle of real work.
 *
 * So the bucket now follows the person, not the address:
 *   * a valid signed-in token  -> its own bucket (per admin / per company user /
 *     per shop session), with a ceiling that fits real use;
 *   * everyone else            -> per IP, with the original strict ceiling.
 *
 * The token is VERIFIED, not just read -- a made-up Authorization header gets no
 * extra allowance. Login endpoints keep their own, much stricter limiter.
 */
const jwt = require('jsonwebtoken');
const { ipKeyGenerator } = require('express-rate-limit');

const ANON_MAX = () => parseInt(process.env.RATE_LIMIT_MAX) || 100;
const AUTH_MAX = () => parseInt(process.env.RATE_LIMIT_AUTH_MAX) || 3000;

/** 'admin:<id>' | 'company_user:<id>' | 'company:<id>' for a valid token, else null. Cached on the request. */
function identityOf(req) {
    if (req._rlIdentity !== undefined) return req._rlIdentity;
    let id = null;
    const h = req.headers && req.headers.authorization;
    if (h && /^Bearer\s+\S+/.test(h) && process.env.JWT_SECRET) {
        try {
            const d = jwt.verify(h.replace(/^Bearer\s+/, ''), process.env.JWT_SECRET, { algorithms: ['HS256'] });
            const who = d.admin_id || d.user_id || d.company_id;
            if (d.type && who) id = `${d.type}:${who}`;
        } catch (_) { /* expired / forged: treated as anonymous */ }
    }
    req._rlIdentity = id;
    return id;
}

const keyGenerator = req => identityOf(req) || `ip:${ipKeyGenerator(req.ip)}`;
const maxFor = req => (identityOf(req) ? AUTH_MAX() : ANON_MAX());

module.exports = { identityOf, keyGenerator, maxFor };
