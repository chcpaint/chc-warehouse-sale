/**
 * utils/scan-out.js
 *
 * Shared rules for the scan-out kiosk (migration 053): the secret link a tablet
 * carries, the badge codes people carry, and the two per-company options.
 *
 * Kept free of database and HTTP code so the rules can be tested on their own.
 */

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

/** Trades a badge can carry, so usage can be reported by painter, bodyman or cage. */
const TRADES = ['painter', 'bodyman', 'prep', 'detailer', 'cage', 'other'];

/**
 * Badge codes avoid the characters people confuse on a printed card (0/O, 1/I)
 * and carry a fixed prefix so a badge can never be mistaken for a product code.
 */
const BADGE_PREFIX = 'ID-';
const BADGE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const BADGE_RANDOM_LEN = 8;

/** A fresh badge code, e.g. `ID-K7M2QX9P`. 32^8 possibilities; collisions are checked by the caller. */
function newBadgeCode() {
    const bytes = crypto.randomBytes(BADGE_RANDOM_LEN);
    let out = '';
    for (let i = 0; i < BADGE_RANDOM_LEN; i++) out += BADGE_ALPHABET[bytes[i] % BADGE_ALPHABET.length];
    return BADGE_PREFIX + out;
}

/**
 * What a scanner actually sends: upper-cased, stray whitespace and control
 * characters gone. A wedge scanner can add a trailing Tab or Enter, and some
 * keyboard layouts turn the hyphen into another dash, so those are mapped back.
 * Returns '' for anything that cannot be a badge code.
 */
function normalizeBadgeCode(raw) {
    const s = String(raw === undefined || raw === null ? '' : raw)
        .replace(/[‐-―−]/g, '-')
        .replace(/[^\x21-\x7e]/g, '')
        .toUpperCase()
        .slice(0, 40);
    return /^[A-Z0-9-]{6,32}$/.test(s) ? s : '';
}

/** Does this scan look like a badge (as opposed to a product)? */
function looksLikeBadge(raw) {
    return normalizeBadgeCode(raw).startsWith(BADGE_PREFIX);
}

/**
 * The secret a tablet's link carries. 32 random bytes, URL-safe: it is
 * guessable only by brute force, and never stored — only its hash is.
 */
function newKioskToken() {
    return crypto.randomBytes(32).toString('base64url');
}

function hashKioskToken(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

/** Well-formed token? Cheap check before touching the database. */
function validKioskToken(token) {
    return /^[A-Za-z0-9_-]{40,60}$/.test(String(token || ''));
}

/**
 * The company's scan-out options with defaults filled in. `require_badge`
 * defaults to ON: recording who took stock is the safe default, and a company
 * that does not care switches it off explicitly.
 */
function scanOutOptions(companySettings) {
    const raw = (companySettings && typeof companySettings === 'object' && companySettings.scan_out) || {};
    return {
        enabled: raw.enabled === true,
        require_badge: raw.require_badge !== false,
        // How long the kiosk waits with nothing happening before it clears an
        // unconfirmed session. Bounded so a typo cannot make it unusable.
        idle_seconds: clampInt(raw.idle_seconds, 20, 600, 60),
        // Stock ordering from the tablet. Off until a company is set up for it.
        order_enabled: raw.order_enabled === true,
        order_contact_name: cleanLine(raw.order_contact_name, 80),
        order_contact_email: cleanEmail(raw.order_contact_email)
    };
}

/** One line of plain text, no markup, capped. */
function cleanLine(v, max) {
    return String(v === undefined || v === null ? '' : v)
        .replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** A plausible email address, lower-cased, or ''. Deliberately simple: the mail server is the real validator. */
function cleanEmail(v) {
    const e = String(v === undefined || v === null ? '' : v).trim().toLowerCase().slice(0, 200);
    return /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/.test(e) ? e : '';
}

// ----------------------------------------------------------------------------
// ORDER PASSCODE
//
// Six to twelve digits, so it can be typed on the tablet's number pad or
// scanned from a card. Stored only as a salted scrypt hash; compared in
// constant time.
// ----------------------------------------------------------------------------
const PASSCODE_MIN = 6;
const PASSCODE_MAX = 12;
const SCRYPT_PREFIX = 'scrypt1';

/** Why a passcode is not acceptable, or null when it is. */
function passcodeProblem(raw) {
    const p = String(raw === undefined || raw === null ? '' : raw);
    if (!/^\d+$/.test(p)) return 'The passcode must be numbers only.';
    if (p.length < PASSCODE_MIN || p.length > PASSCODE_MAX) {
        return `The passcode must be ${PASSCODE_MIN} to ${PASSCODE_MAX} digits.`;
    }
    if (/^(\d)\1+$/.test(p)) return 'Choose a passcode that is not one digit repeated.';
    const asc = '0123456789012345678901234567890', desc = '9876543210987654321098765432109';
    if (asc.includes(p) || desc.includes(p)) return 'Choose a passcode that is not a simple run like 123456.';
    return null;
}

async function hashPasscode(passcode) {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(String(passcode), salt, 32);
    return `${SCRYPT_PREFIX}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

async function verifyPasscode(passcode, stored) {
    try {
        const [prefix, saltB64, keyB64] = String(stored || '').split('$');
        if (prefix !== SCRYPT_PREFIX || !saltB64 || !keyB64) return false;
        const want = Buffer.from(keyB64, 'base64url');
        const got = await scrypt(String(passcode === undefined || passcode === null ? '' : passcode), Buffer.from(saltB64, 'base64url'), want.length);
        return want.length === got.length && crypto.timingSafeEqual(want, got);
    } catch (_) {
        return false;
    }
}

// Five wrong tries lock the order screen on that tablet for five minutes.
const ORDER_MAX_FAILS = 5;
const ORDER_LOCK_MS = 5 * 60 * 1000;

/** How long an unlocked order screen's token lasts, and how long the screen waits before locking itself. */
const ORDER_TOKEN_SECONDS = 30 * 60;

function clampInt(v, lo, hi, fallback) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
}

/** Valid trade or null. */
function cleanTrade(v) {
    const t = String(v || '').trim().toLowerCase();
    return TRADES.includes(t) ? t : null;
}

module.exports = {
    TRADES,
    BADGE_PREFIX,
    newBadgeCode,
    normalizeBadgeCode,
    looksLikeBadge,
    newKioskToken,
    hashKioskToken,
    validKioskToken,
    scanOutOptions,
    cleanTrade,
    cleanLine,
    cleanEmail,
    passcodeProblem,
    hashPasscode,
    verifyPasscode,
    PASSCODE_MIN,
    PASSCODE_MAX,
    ORDER_MAX_FAILS,
    ORDER_LOCK_MS,
    ORDER_TOKEN_SECONDS
};
