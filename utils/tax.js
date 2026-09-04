/**
 * utils/tax.js
 *
 * Sales tax on a customer order.
 *
 * CHC's own invoices already charge Ontario HST at 13%, and until now this
 * console's orders did not — the `tax` column on `orders` existed but was
 * never written to, so an order's total and its invoice's total disagreed by
 * exactly the tax amount, every time. That mismatch is the entire reason
 * this file exists: an order has to show the same tax the invoice shows, or
 * "does this match the invoice" stays a manual check forever.
 *
 * This follows the same shape as utils/po.js on purpose — a per-company
 * settings block with a sane default, resolved by one pure function so the
 * storefront and any future path (an imported order, a phone order, a
 * report) cannot disagree about it:
 *
 *   - Every company defaults to 13% (Ontario HST) — CHC's home province, and
 *     what every existing customer is actually charged today. Nothing
 *     changes for anyone until somebody sets a different rate, so turning
 *     this on does not silently alter a rate that was already correct.
 *   - A company can be marked tax-exempt (a band, a government account, a
 *     reseller with a valid exemption certificate on file) — 0% regardless
 *     of what the rate is set to.
 *   - A company can be given a different rate — this console already has an
 *     out-of-province customer (Nova Scotia, see company_locations.province)
 *     — without CHC needing a code change for every province a customer
 *     happens to be in.
 *
 * Tax is computed on the priced subtotal only. A price-on-request line has
 * no price yet, so it has no tax yet either — it gets taxed once the branch
 * prices it, not estimated now and corrected later.
 */

/** Ontario HST. What every company is charged unless configured otherwise. */
const DEFAULT_RATE = 0.13;

function isFiniteRate(v) {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

/** The tax block of a company's settings, with defaults filled in. */
function taxSettings(companySettings) {
    const raw = (companySettings && typeof companySettings === 'object' && companySettings.tax) || {};
    const exempt = raw.exempt === true;
    const hasCustomRate = !exempt && isFiniteRate(raw.rate);
    return {
        rate: exempt ? 0 : (hasCustomRate ? Number(raw.rate) : DEFAULT_RATE),
        exempt,
        // True only when nothing has been configured for this company — the
        // admin screen uses this to show "13% (default)" rather than making
        // it look like someone deliberately chose 13%.
        is_default: !exempt && !hasCustomRate
    };
}

/**
 * Tax owed on a priced subtotal.
 *
 * Rounded to the cent the way money is rounded, never truncated, so it foots
 * the same way a hand calculator or CHC's own invoice would. Takes a rate or
 * a settings object interchangeably so callers who already resolved the
 * rate (e.g. to show it elsewhere on the same request) don't resolve it
 * twice.
 */
function computeTax(subtotal, settingsOrRate) {
    const rate = typeof settingsOrRate === 'number' ? settingsOrRate : taxSettings(settingsOrRate).rate;
    const amount = Number(subtotal || 0) * rate;
    return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/**
 * Validate a rate typed into the admin console.
 *
 * Accepts empty/null/undefined as "clear the override, go back to default" —
 * that is a real, common choice (a customer's exemption certificate expired,
 * or a rate was set by mistake) and must not be confused with 0%, which is
 * itself a legitimate rate for a genuinely zero-rated sale.
 */
function validateRate(value) {
    if (value === undefined || value === null || value === '') {
        return { ok: true, rate: undefined };
    }
    const n = Number(value);
    if (!isFiniteRate(n)) {
        return { ok: false, error: 'Tax rate must be a number between 0 and 1 — for example 0.13 for 13%.' };
    }
    return { ok: true, rate: n };
}

module.exports = {
    DEFAULT_RATE,
    taxSettings,
    computeTax,
    validateRate
};
