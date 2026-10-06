/**
 * utils/shopsafe.js
 *
 * The hand-off from this portal to RefinishAI ShopSafe (the shop compliance
 * app, a separate service). When a customer clicks "ShopSafe", the portal
 * signs a short-lived, single-use token naming the company, location and
 * person, and sends the browser to ShopSafe's /launch page with it. ShopSafe
 * verifies the token with the same secret, finds or creates the linked shop,
 * and starts its own session.
 *
 * Why a separate secret: the portal's JWT_SECRET signs portal sessions. If it
 * were shared, a ShopSafe compromise could mint portal sessions. The hand-off
 * secret (SHOPSAFE_HANDOFF_SECRET) can only produce ShopSafe sign-ins.
 *
 * The portal's own session token never leaves the portal.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ISSUER = 'refinishai-portal';
const AUDIENCE = 'refinishai-shopsafe';

function shopsafeConfigured() {
    const secret = process.env.SHOPSAFE_HANDOFF_SECRET || '';
    return !!(process.env.SHOPSAFE_URL && secret.length >= 32);
}

/**
 * @param {Object} p
 * @param {{id:string, name:string}} p.company
 * @param {{id:string, name:string, province?:string}|null} p.location
 * @param {{id?:string, email:string, name:string, role:string}} p.user
 * @param {string} p.distributorId
 * @returns {string} the URL to send the browser to
 */
function buildLaunchUrl({ company, location, user, distributorId }) {
    if (!shopsafeConfigured()) throw new Error('ShopSafe is not configured.');
    const token = jwt.sign({
        typ: 'shopsafe_handoff',
        jti: crypto.randomUUID(),
        distributor_id: distributorId || null,
        company_id: company.id,
        company_name: company.name,
        location_id: location ? location.id : null,
        location_name: location ? location.name : null,
        province: location && location.province ? location.province : null,
        // shared = the company access-code session, not a person. ShopSafe
        // gives it a separate manager-level identity and never matches it to
        // a real login, whatever email it carries.
        user: user.shared || !user.id
            ? { id: null, shared: true, email: user.email || null, name: user.name, role: 'manager' }
            : { id: user.id, email: user.email, name: user.name, role: user.role === 'owner' ? 'owner' : 'manager' }
    }, process.env.SHOPSAFE_HANDOFF_SECRET, {
        algorithm: 'HS256', issuer: ISSUER, audience: AUDIENCE, expiresIn: '2m'
    });
    const base = process.env.SHOPSAFE_URL.replace(/\/$/, '');
    return `${base}/launch?t=${encodeURIComponent(token)}`;
}

module.exports = { buildLaunchUrl, shopsafeConfigured, ISSUER, AUDIENCE };
