/**
 * Payments (Stripe) — INERT SCAFFOLD.
 *
 * This module is pre-wired but disabled until BOTH of these are true:
 *   1. process.env.STRIPE_SECRET_KEY is set (and the `stripe` package is installed), and
 *   2. the company has settings.payments.enabled === true.
 *
 * With no key set, getStripe() returns null and every payment route reports "disabled",
 * so the current PO-based checkout is completely unaffected.
 *
 * TO ACTIVATE LATER:
 *   - `npm i stripe` (already listed in package.json)
 *   - set STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET in the env
 *   - set companies.settings.payments = { enabled: true } for the tenant(s)
 *   - implement the confirm/fulfilment logic marked with TODO in routes/storefront.js
 */

let _stripe;            // memoized client (or false once we know it's unavailable)

function getStripe() {
    if (_stripe !== undefined) return _stripe || null;
    if (!process.env.STRIPE_SECRET_KEY) { _stripe = false; return null; }
    try {
        // Lazy require so a missing package never crashes the app when payments are off.
        const Stripe = require('stripe');
        _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
    } catch (err) {
        console.warn('[payments] STRIPE_SECRET_KEY is set but the `stripe` package is not installed — payments stay disabled.');
        _stripe = false;
    }
    return _stripe || null;
}

/** Per-company toggle: requires a configured Stripe client AND the tenant flag. */
function paymentsEnabled(company) {
    return !!getStripe() && !!(company && company.settings && company.settings.payments && company.settings.payments.enabled);
}

/** Safe public config for the storefront (never exposes secret keys). */
function publicPaymentConfig(company) {
    return {
        enabled: paymentsEnabled(company),
        provider: 'stripe',
        publishable_key: paymentsEnabled(company) ? (process.env.STRIPE_PUBLISHABLE_KEY || null) : null
    };
}

module.exports = { getStripe, paymentsEnabled, publicPaymentConfig };
