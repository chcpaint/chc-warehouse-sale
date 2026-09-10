/**
 * utils/delivery-fee.js
 *
 * A flat delivery fee CHC adds to a small order, so a $40 order does not cost
 * the same to fulfil as a $4,000 one for free.
 *
 * This follows the same shape as utils/tax.js and utils/po.js on purpose — a
 * per-company settings block with a sane default, resolved by one pure
 * function so the storefront, the replenishment-approval order path, and any
 * future one (a phone order, an imported order) cannot disagree about it:
 *
 *   - Every order under $300 (on the priced subtotal, before tax) is charged
 *     a flat $10 delivery fee. $300 and up, nothing is added.
 *   - A company can be marked exempt — the fee never applies to their orders,
 *     regardless of size. ON by default is the deliberate choice here: the
 *     fee applies unless a manager or admin turns it off for that account,
 *     not the other way around.
 *   - The threshold is evaluated on the same priced subtotal tax is computed
 *     on. A price-on-request line has no price yet, so it cannot push an
 *     order over the threshold any more than it can be taxed — see
 *     utils/tax.js for the same reasoning.
 */

/** Below this priced subtotal, the fee applies. At or above it, it doesn't. */
const THRESHOLD = 300;

/** What the fee costs when it applies. */
const FEE = 10;

/** The delivery-fee block of a company's settings, with defaults filled in. */
function deliveryFeeSettings(companySettings) {
    const raw = (companySettings && typeof companySettings === 'object' && companySettings.delivery_fee) || {};
    return {
        // On for everybody until a manager or admin turns it off — only an
        // explicit `false` does that. Nothing else in the block currently
        // varies per company; the threshold and fee amount are fixed.
        enabled: raw.enabled !== false
    };
}

/**
 * The delivery fee owed on a priced subtotal.
 *
 * The second argument is either the RAW company `settings` column (the same
 * value deliveryFeeSettings() itself takes), or an already-resolved `enabled`
 * boolean — never the object deliveryFeeSettings() returns. That distinction
 * matters: passing `deliveryFeeSettings(company.settings)` straight back in
 * here would resolve it a second time against the wrong shape and silently
 * default back to enabled. Callers who already resolved settings for another
 * reason on the same request should pass `.enabled`, the same way callers of
 * computeTax() pass `resolvedTax.rate`, never `resolvedTax` itself.
 */
function computeDeliveryFee(subtotal, settingsOrEnabled) {
    const enabled = typeof settingsOrEnabled === 'boolean'
        ? settingsOrEnabled
        : deliveryFeeSettings(settingsOrEnabled).enabled;
    if (!enabled) return 0;
    return Number(subtotal || 0) < THRESHOLD ? FEE : 0;
}

module.exports = {
    THRESHOLD,
    FEE,
    deliveryFeeSettings,
    computeDeliveryFee
};
