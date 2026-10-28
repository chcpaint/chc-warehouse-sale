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

const { isCountry } = require('./tax-regions');

function isFiniteRate(v) {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

/**
 * A distributor's own tax block (distributors.settings.tax), normalised.
 *
 *   { country: 'CA'|'US', region: 'ON', rate: 0.13, rates: { TX: 0.0825, ... } }
 *
 * `rate` is the distributor's default rate for every client that has no rate
 * of its own. `rates` is the per-state/province table, used when a client is
 * tagged with a region (companies.settings.tax.region). Returns null when the
 * distributor has configured nothing, which keeps every existing tenant on
 * the old 13% default.
 */
function distributorTax(distributorSettings) {
    const raw = (distributorSettings && typeof distributorSettings === 'object' && distributorSettings.tax) || null;
    if (!raw || typeof raw !== 'object') return null;
    const country = isCountry(raw.country) ? raw.country : null;
    const rates = {};
    if (raw.rates && typeof raw.rates === 'object') {
        for (const [code, v] of Object.entries(raw.rates)) {
            if (isFiniteRate(v) && /^[A-Z]{2}$/.test(code)) rates[code] = Number(v);
        }
    }
    const rate = isFiniteRate(raw.rate) ? Number(raw.rate) : null;
    if (!country && rate === null && !Object.keys(rates).length) return null;
    return {
        country: country || 'CA',
        region: typeof raw.region === 'string' && /^[A-Z]{2}$/.test(raw.region) ? raw.region : null,
        rate,
        rates
    };
}

/**
 * The tax a company is charged, with defaults filled in.
 *
 * Resolution order (first match wins):
 *   1. company marked exempt                        -> 0%
 *   2. company has its own rate                     -> that rate
 *   3. company tagged with a region the distributor
 *      has a saved rate for                         -> that region's rate
 *   4. distributor default rate (their home region) -> that rate
 *   5. nothing configured                           -> 13% (Ontario HST)
 *
 * `distributorSettings` is optional; callers that omit it get exactly the old
 * behaviour.
 */
function taxSettings(companySettings, distributorSettings) {
    const raw = (companySettings && typeof companySettings === 'object' && companySettings.tax) || {};
    const exempt = raw.exempt === true;
    const hasCustomRate = !exempt && isFiniteRate(raw.rate);
    const dist = distributorTax(distributorSettings);
    const region = typeof raw.region === 'string' && /^[A-Z]{2}$/.test(raw.region) ? raw.region : null;

    let rate = DEFAULT_RATE;
    let source = 'default';
    if (exempt) { rate = 0; source = 'exempt'; }
    else if (hasCustomRate) { rate = Number(raw.rate); source = 'company'; }
    else if (dist && region && dist.rates[region] !== undefined) { rate = dist.rates[region]; source = 'region'; }
    else if (dist && dist.rate !== null) { rate = dist.rate; source = 'distributor'; }

    return {
        rate,
        exempt,
        // True only when nothing has been configured at any level — the admin
        // screen uses this to show "13% (default)" rather than making it look
        // like someone deliberately chose 13%.
        is_default: source === 'default',
        source,
        region,
        country: dist ? dist.country : 'CA'
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
    distributorTax,
    computeTax,
    validateRate
};
