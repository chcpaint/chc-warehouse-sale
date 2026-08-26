/**
 * utils/price-rules.js
 *
 * The decision behind the two standing rules in migration 024, expressed once
 * in JavaScript so it can be tested, reused by import previews, and read by a
 * person without opening a trigger.
 *
 * THE DATABASE IS THE ENFORCER, NOT THIS FILE.
 *
 * The 25 August 2026 import that mispriced 168 of Concord's lines wrote
 * straight to `products` and never touched this codebase. That is exactly why
 * the real rule is a trigger: it sees every write, whatever the path. This
 * module must stay in step with migration 024 — if you change a threshold in
 * one, change it in the other, and the tests in tests/price-rules.test.js will
 * tell you what the old behaviour was.
 *
 * Use it to warn somebody BEFORE they submit, so the database refusal is a
 * backstop rather than the first they hear of it.
 */

/** Below this, a price is a decimal error rather than a deal. Refused. */
const REFUSE_BELOW = 0.15;

/** Below this, allowed but recorded — real trade discounts reach here. */
const RECORD_BELOW = 0.30;

/**
 * Above this, allowed but recorded. Usually a case price against a per-unit
 * list (a box of ten filters at ten times one filter), which is correct and
 * still worth a glance.
 */
const RECORD_ABOVE = 4.0;

/**
 * What should happen to this price?
 *
 * Returns { action: 'accept'|'refuse', record: boolean, ratio, severity, message }
 *
 * Silent by design when there is nothing to compare against. Most of the
 * catalogue is not in the reference library, and a rule that guesses in the
 * dark gets switched off.
 */
function priceVerdict(price, listPrice, opts = {}) {
    const { priceOnRequest = false, allowOutliers = false } = opts;

    const p = Number(price);
    const lp = Number(listPrice);

    const noOpinion = { action: 'accept', record: false, ratio: null, severity: null, message: null };

    // A deliberate "contact us for pricing" line carries no number to judge.
    if (priceOnRequest) return noOpinion;
    if (!Number.isFinite(p) || p === 0) return noOpinion;
    if (!Number.isFinite(lp) || lp === 0) return noOpinion;

    const ratio = p / lp;

    if (ratio < REFUSE_BELOW) {
        const message =
            `Price ${p.toFixed(2)} is ${(ratio * 100).toFixed(1)}% of the ` +
            `${lp.toFixed(2)} list price — that is a decimal error, not a discount.`;

        // An override that leaves no trace is the same as having no rule, so an
        // allowed outlier is still written to the queue.
        return allowOutliers
            ? { action: 'accept', record: true, ratio, severity: 'blocked-override', message }
            : { action: 'refuse', record: false, ratio, severity: 'blocked', message };
    }

    if (ratio < RECORD_BELOW || ratio > RECORD_ABOVE) {
        return {
            action: 'accept', record: true, ratio, severity: 'flagged',
            message: `Price ${p.toFixed(2)} is ${(ratio * 100).toFixed(1)}% of list — worth a check.`
        };
    }

    return { action: 'accept', record: false, ratio, severity: null, message: null };
}

// ------------------------------------------------------------------
// Where a chemical files itself
// ------------------------------------------------------------------

/** Things that merely mention a chemical but are hardware. Checked first. */
const NOT_A_CHEMICAL = /(filter|holder|applicator|hose|spigot|faucet|crimper|tipper|spout|gauge|pad)/i;

const IS_A_CHEMICAL = [
    /(gun ?wash|final wash|solvent wash|wax ?(and|&) ?grease|degreas)/i,
    /(reducer|thinner|acetone|isopropyl|iso alcohol|alcohol 99|solvent cleaner|tool ?& ?equipment cleaner|adhesive remover)/i
];

/** The category this product would file itself under, or null for no opinion. */
function suggestCategory(name) {
    const n = String(name || '');
    if (!n) return null;
    if (NOT_A_CHEMICAL.test(n)) return null;
    if (IS_A_CHEMICAL.some(re => re.test(n))) return 'Solvents/Chemicals';
    return null;
}

/**
 * The category a product should end up with, given what it already has.
 *
 * Fills a gap; never overrules a person. 'Misc' counts as a gap because it is
 * what an importer writes when it has nothing better, not a decision anyone
 * made. A PPG reducer deliberately filed under Colour belongs with the paint it
 * thins, and this rule has no business second-guessing that.
 */
function applyCategory(name, current) {
    const isGap = current === null || current === undefined || current === '' || current === 'Misc';
    if (!isGap) return current;
    return suggestCategory(name) ?? current ?? null;
}

module.exports = {
    priceVerdict,
    suggestCategory,
    applyCategory,
    REFUSE_BELOW,
    RECORD_BELOW,
    RECORD_ABOVE
};
