/**
 * utils/po.js
 *
 * Purchase-order numbers CHC issues on a customer's behalf.
 *
 * Some shops have an accounting system that issues POs and some do not, and the
 * ones that do not currently type whatever they like. Today's live data shows
 * exactly where that ends: the same PO, `123456`, on five separate orders across
 * two companies. Nothing caught it, because `po_number` is free text with no
 * constraint anywhere.
 *
 * The design rests on four decisions, each of which is a failure mode avoided:
 *
 * 1. THE DATABASE ISSUES THE NUMBER. Allocation is a single atomic
 *    `UPDATE ... RETURNING` on a counter row, so two people pressing submit in
 *    the same second get different numbers. A "read the last one, add one"
 *    approach loses that race quietly and is the classic way these break.
 *
 * 2. UNIQUENESS IS A CONSTRAINT, NOT A CHECK. `uq_orders_po_per_company` is
 *    what actually prevents reuse. Checking-then-inserting is a race; a unique
 *    index is not. It covers typed POs too, so a shop cannot reuse one by hand.
 *
 * 3. THE COUNTER NEVER RESETS. Not annually, not ever. Year-resets are the
 *    single commonest way PO sequences reissue an old number. A shop that wants
 *    the year visible gets it in the prefix (ASR26-) and starts a new prefix,
 *    which is safe because the prefix is part of the number.
 *
 * 4. ONE CHECK DIGIT. POs get read down the phone and retyped into accounting
 *    systems. A check digit lets CHC tell a mistyped number from an unknown one
 *    without a lookup, which is the difference between "that PO is wrong" and
 *    "that PO does not exist" — two very different conversations.
 *
 * The check digit is Luhn, computed over the prefix letters mapped A=1..Z=26
 * plus the sequence digits. Luhn catches every single-digit error and almost
 * every transposition of adjacent digits, which are the two things a human
 * actually does wrong. It is not a security measure and is not meant to be:
 * anyone can compute it. It catches mistakes, not forgery.
 */

/** Prefixes are short, upper-case, and unique across all companies. */
const PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,7}$/;

const MIN_PAD = 3;
const MAX_PAD = 9;
const DEFAULT_PAD = 5;

/**
 * Normalise a PO for comparison and storage. Case and surrounding whitespace
 * carry no meaning, so `asr-00042-7` and `ASR-00042-7 ` are the same PO and
 * must not both be issuable.
 */
function normalizePo(value) {
    const s = String(value === undefined || value === null ? '' : value).trim().toUpperCase();
    return s === '' ? null : s;
}

/**
 * Map a PO body to the digit string the check digit is computed over.
 * Letters become their position in the alphabet so the prefix participates —
 * without it, ASR-00042 and BTQ-00042 would share a check digit and the digit
 * would say nothing about whether the prefix was heard correctly.
 */
function digitsFor(prefix, sequence) {
    let out = '';
    for (const ch of String(prefix).toUpperCase()) {
        if (ch >= 'A' && ch <= 'Z') out += String(ch.charCodeAt(0) - 64);
        else if (ch >= '0' && ch <= '9') out += ch;
    }
    out += String(sequence).replace(/\D/g, '');
    return out;
}

/**
 * Luhn check digit. Doubling from the right, subtracting 9 from any result
 * above 9, the digit is what makes the total a multiple of ten.
 */
function luhnCheckDigit(digits) {
    let sum = 0;
    let double = true;                     // the check digit will sit to the right
    for (let i = digits.length - 1; i >= 0; i--) {
        let d = digits.charCodeAt(i) - 48;
        if (d < 0 || d > 9) continue;
        if (double) { d *= 2; if (d > 9) d -= 9; }
        double = !double;
        sum += d;
    }
    return (10 - (sum % 10)) % 10;
}

/**
 * Build the printed PO from its parts: `ASR-00042-7`.
 *
 * Three segments rather than one run of characters, because this number gets
 * read aloud and copied by hand, and grouping is what makes that survivable.
 */
function formatPo(prefix, sequence, { padWidth = DEFAULT_PAD, checkDigit = true } = {}) {
    const pad = Math.min(MAX_PAD, Math.max(MIN_PAD, Number(padWidth) || DEFAULT_PAD));
    const body = String(sequence).padStart(pad, '0');
    const base = `${String(prefix).toUpperCase()}-${body}`;
    if (!checkDigit) return base;
    return `${base}-${luhnCheckDigit(digitsFor(prefix, body))}`;
}

/**
 * Is this a well-formed PO that we issued, and does its check digit agree?
 *
 * Deliberately distinguishes the three answers a branch actually needs:
 *   not_ours   — the shape is not one of ours; it is the shop's own number
 *   mistyped   — our shape, but the check digit disagrees: read it back
 *   ok         — our shape and internally consistent
 *
 * "ok" means the number is well-formed, NOT that it exists. Only the database
 * can say that, and saying otherwise here would be a lie a branch might act on.
 */
function inspectPo(value) {
    const po = normalizePo(value);
    if (!po) return { status: 'not_ours', reason: 'empty' };

    const m = /^([A-Z][A-Z0-9]{1,7})-(\d{3,9})-(\d)$/.exec(po);
    if (!m) return { status: 'not_ours', reason: 'does not match an issued format' };

    const [, prefix, body, given] = m;
    const expected = luhnCheckDigit(digitsFor(prefix, body));

    if (Number(given) !== expected) {
        return {
            status: 'mistyped', prefix, sequence: Number(body),
            expected_check_digit: expected,
            reason: 'check digit does not match — likely a digit misread or two digits swapped'
        };
    }
    return { status: 'ok', prefix, sequence: Number(body), normalized: po };
}

/** Validate a prefix a person typed into the admin console. */
function validatePrefix(value) {
    const prefix = String(value || '').trim().toUpperCase();
    if (!prefix) return { ok: false, error: 'A prefix is required.' };
    if (!PREFIX_PATTERN.test(prefix)) {
        return {
            ok: false,
            error: 'A prefix must start with a letter and be 2 to 8 letters or digits — for example ASR or ASR26.'
        };
    }
    return { ok: true, prefix };
}

function validatePadWidth(value) {
    if (value === undefined || value === null || value === '') return { ok: true, padWidth: DEFAULT_PAD };
    const n = Number(value);
    if (!Number.isInteger(n) || n < MIN_PAD || n > MAX_PAD) {
        return { ok: false, error: `Number width must be between ${MIN_PAD} and ${MAX_PAD} digits.` };
    }
    return { ok: true, padWidth: n };
}

/**
 * A worked example for the admin screen, so whoever sets the prefix can see
 * what a shop will actually be looking at before they save it.
 */
function exampleFor(prefix, padWidth = DEFAULT_PAD, checkDigit = true) {
    return formatPo(prefix, 42, { padWidth, checkDigit });
}

/**
 * How a company handles purchase orders.
 *
 *   off        the company does not use POs; the field never appears and an
 *              order flows straight through
 *   manual     the shop's accounting system issues them; they type it, and it
 *              still has to be unique
 *   generated  CHC issues it from the company's sequence at the moment the
 *              order is placed
 *
 * `manual` is the default because it is exactly what every company does today,
 * so nothing changes for anyone until somebody chooses otherwise. A migration
 * that silently alters live behaviour is a migration that gets blamed for the
 * next unrelated problem.
 */
const PO_MODES = ['off', 'manual', 'generated'];
const DEFAULT_PO_MODE = 'manual';

/** The PO block of a company's settings, with defaults filled in. */
function poSettings(companySettings) {
    const raw = (companySettings && typeof companySettings === 'object' && companySettings.purchase_orders) || {};
    const mode = PO_MODES.includes(raw.mode) ? raw.mode : DEFAULT_PO_MODE;
    return {
        mode,
        required: mode !== 'off',
        // True only when CHC issues the number, which is also the only case
        // where the shop must not be able to edit it.
        issued_by_chc: mode === 'generated'
    };
}

/**
 * Decide what to do with the PO on an incoming order.
 *
 * Pure, so the rule can be tested without a database, and so the storefront and
 * any future path (a phone app, an imported order) cannot disagree about it.
 *
 * @returns {{ok:true, action:'none'|'manual'|'allocate', po_number?:string}
 *          |{ok:false, error:string}}
 */
function resolveOrderPo(companySettings, submitted) {
    const { mode } = poSettings(companySettings);
    const typed = normalizePo(submitted);

    if (mode === 'off') {
        // Anything typed is ignored rather than stored. Keeping it would create
        // a PO on a company that has said it does not use them, which is the
        // sort of half-state that confuses a branch later.
        return { ok: true, action: 'none' };
    }

    if (mode === 'generated') {
        return { ok: true, action: 'allocate' };
    }

    if (!typed) {
        return { ok: false, error: 'A purchase order number is required.' };
    }
    if (typed.length > 60) {
        return { ok: false, error: 'That purchase order number is too long.' };
    }
    return { ok: true, action: 'manual', po_number: typed };
}

module.exports = {
    normalizePo,
    formatPo,
    inspectPo,
    luhnCheckDigit,
    digitsFor,
    validatePrefix,
    validatePadWidth,
    exampleFor,
    PREFIX_PATTERN,
    MIN_PAD, MAX_PAD, DEFAULT_PAD,
    PO_MODES, DEFAULT_PO_MODE,
    poSettings, resolveOrderPo
};
