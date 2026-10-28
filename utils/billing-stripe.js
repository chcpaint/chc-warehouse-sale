/**
 * utils/billing-stripe.js
 *
 * Stripe Checkout for console subscriptions. Takes an already-priced quote
 * (utils/billing.js) and the Stripe client from utils/payments.js -- passing the
 * client in keeps this testable with a fake and keeps the app working with no
 * Stripe key at all.
 *
 * Money flow: if the distributor has a connected Stripe account (stripe_account_id,
 * status 'active'), the subscription is a destination charge -- the customer pays
 * and the funds go to the distributor, less an optional platform fee
 * (distributors.settings.billing.platform_fee_percent, else STRIPE_PLATFORM_FEE_PERCENT,
 * else 0). With no connected account the platform's own Stripe account collects.
 */

const { encodeLines } = require('./billing-db');

function platformFeePercent(distributor) {
    const own = Number(distributor?.settings?.billing?.platform_fee_percent);
    const env = Number(process.env.STRIPE_PLATFORM_FEE_PERCENT);
    const v = Number.isFinite(own) && own > 0 ? own : (Number.isFinite(env) && env > 0 ? env : 0);
    return Math.min(v, 50);
}

async function createCheckoutSession(stripe, { company, distributor, quote, email, successUrl, cancelUrl }) {
    const params = {
        mode: 'subscription',
        client_reference_id: company.id,
        customer_email: email || undefined,
        line_items: quote.lines.map(l => ({
            quantity: l.quantity,
            price_data: {
                currency: quote.currency,
                unit_amount: l.unit_amount_cents,
                recurring: { interval: quote.interval },
                product_data: { name: `${l.label}${l.unit === 'location' ? ' (per location)' : ''}` }
            }
        })),
        success_url: successUrl,
        cancel_url: cancelUrl,
        allow_promotion_codes: true,
        metadata: {
            kind: 'console_subscription', company_id: company.id, distributor_id: distributor?.id || '',
            interval: quote.interval, lines: encodeLines(quote.lines)
        }
    };
    const sub = { metadata: { kind: 'console_subscription', company_id: company.id } };
    if (distributor?.stripe_account_id && distributor.stripe_connect_status === 'active') {
        sub.transfer_data = { destination: distributor.stripe_account_id };
        const fee = platformFeePercent(distributor);
        if (fee > 0) sub.application_fee_percent = fee;
    }
    params.subscription_data = sub;
    if (process.env.STRIPE_AUTOMATIC_TAX === 'true') params.automatic_tax = { enabled: true };
    return stripe.checkout.sessions.create(params);
}

async function createPortalSession(stripe, { customerId, returnUrl }) {
    return stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
}

module.exports = { createCheckoutSession, createPortalSession, platformFeePercent };
