/**
 * routes/billing-store.js
 *
 * A customer's own "Plans & billing" page, mounted from routes/storefront.js at
 *   /api/store/:slug/billing
 *
 * Anyone signed in can see what is available and what the company has. Only the
 * company owner can buy or manage billing (or, for a company that does not use
 * individual logins, the shared company session -- the only login there is).
 * The sales portal itself is always free. Payment is Stripe Checkout; this file
 * never sees card details.
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requireCompanyAuth } = require('../middleware/auth');
const { getStripe } = require('../utils/payments');
const { distributorTax } = require('../utils/tax');
const { resolveOrderingUser } = require('../utils/people-activity');
const B = require('../utils/billing');
const db = require('../utils/billing-db');
const { createCheckoutSession, createPortalSession } = require('../utils/billing-stripe');

const router = express.Router({ mergeParams: true });
router.use(requireCompanyAuth);

async function load(req, res, next) {
    try {
        const { data: company, error } = await supabaseAdmin.from('companies')
            .select('id, name, slug, settings, distributor_id').eq('id', req.company.id).maybeSingle();
        if (error) throw error;
        if (!company) return res.status(404).json({ error: 'Company not found.' });
        let distributor = null;
        if (company.distributor_id) {
            const d = await supabaseAdmin.from('distributors')
                .select('id, name, settings, stripe_account_id, stripe_connect_status').eq('id', company.distributor_id).maybeSingle();
            distributor = d.data || null;
        }
        req.billingCompany = company;
        req.billingDistributor = distributor;
        next();
    } catch (err) {
        console.error('Billing load error:', err);
        res.status(500).json({ error: 'Could not load your billing.' });
    }
}
router.use(load);

/** Owner (re-checked against the database), or the shared session when it is the only login. */
async function canManage(req) {
    if (req.companyUser) {
        const r = await resolveOrderingUser(req.company.id, req.companyUser);
        return r.ok && r.user.role === 'owner';
    }
    return req.billingCompany.settings?.users?.enabled !== true;
}
async function requireManager(req, res, next) {
    try {
        if (!(await canManage(req))) return res.status(403).json({ error: 'Only the account owner can change plans and billing.' });
        next();
    } catch (err) {
        console.error('Billing owner check failed:', err);
        res.status(500).json({ error: 'Could not verify your access.' });
    }
}

async function pricesFor(req) {
    const did = req.billingCompany.distributor_id;
    const country = distributorTax(req.billingDistributor?.settings)?.country || 'CA';
    return B.resolvePrices(await db.loadPrices(supabaseAdmin, did), did, country);
}

async function activeLocationCount(companyId) {
    const { data } = await supabaseAdmin.from('company_locations').select('id').eq('company_id', companyId).eq('is_active', true);
    return Math.max(1, (data || []).length);
}

/** GET /plans */
router.get('/plans', async (req, res) => {
    try {
        const company = req.billingCompany;
        const cfg = B.billingConfig(company.settings);
        const prices = await pricesFor(req);
        const rows = await db.loadEntitlements(supabaseAdmin, company.id);
        res.json({
            company: { id: company.id, name: company.name },
            mode: cfg.mode,
            entitled: cfg.entitled,
            locations: await activeLocationCount(company.id),
            can_manage: await canManage(req),
            payments_ready: !!getStripe(),
            currency: Object.values(prices)[0].currency,
            free: { label: 'Sales portal', blurb: 'Ordering, your price list, promotions, order history and individual logins. Always free.' },
            items: B.ITEM_KEYS.map(k => ({
                item: k, label: B.ITEMS[k].label, blurb: B.ITEMS[k].blurb, unit: B.ITEMS[k].unit, bundle: B.ITEMS[k].bundle || null,
                month_cents: prices[k].month, year_cents: prices[k].year,
                owned: B.expand(k).every(c => cfg.entitled.includes(c))
            })),
            subscriptions: rows.map(r => ({
                item: r.item, status: r.status, source: r.source, interval: r.interval, quantity: r.quantity,
                unit_amount_cents: r.unit_amount_cents, current_period_end: r.current_period_end,
                cancel_at_period_end: r.cancel_at_period_end, comp_until: r.comp_until
            })),
            can_manage_billing_portal: rows.some(r => r.source === 'paid' && r.stripe_customer_id)
        });
    } catch (err) {
        console.error('Billing plans error:', err);
        res.status(500).json({ error: 'Failed to load plans.' });
    }
});

async function priced(req) {
    const cfg = B.billingConfig(req.billingCompany.settings);
    return B.quote({
        items: req.body?.items, interval: req.body?.interval,
        locations: req.body?.locations ?? await activeLocationCount(req.billingCompany.id),
        prices: await pricesFor(req), owned: cfg.entitled
    });
}

/** POST /quote   Body: { items, interval, locations? } */
router.post('/quote', async (req, res) => {
    try {
        const q = await priced(req);
        if (!q.ok) return res.status(400).json({ error: q.error });
        res.json(q);
    } catch (err) {
        console.error('Billing quote error:', err);
        res.status(500).json({ error: 'Could not price that.' });
    }
});

/** POST /checkout   Body: { items, interval, locations? } -> { url } or { activated } */
router.post('/checkout', requireManager, async (req, res) => {
    try {
        const company = req.billingCompany;
        const q = await priced(req);
        if (!q.ok) return res.status(400).json({ error: q.error });

        // The distributor priced these at $0: nothing to pay, switch them on.
        if (q.total_cents === 0) {
            await db.applyFreePriced(supabaseAdmin, { company, lines: q.lines.map(l => ({ item: l.item, quantity: l.quantity })), interval: q.interval, currency: q.currency });
            return res.json({ activated: true, message: 'Switched on — there is nothing to pay.' });
        }

        const stripe = getStripe();
        if (!stripe) return res.status(503).json({ error: 'Online payment is not switched on yet. Ask your supplier to set it up.' });

        const origin = `${req.protocol}://${req.get('host')}`;
        const base = `${origin}/store/${encodeURIComponent(company.slug)}`;
        const session = await createCheckoutSession(stripe, {
            company, distributor: req.billingDistributor, quote: q,
            email: req.companyUser?.email || null,
            successUrl: `${base}?billing=success`, cancelUrl: `${base}?billing=cancelled`
        });
        res.json({ url: session.url, total_cents: q.total_cents, currency: q.currency });
    } catch (err) {
        console.error('Billing checkout error:', err);
        res.status(500).json({ error: 'Could not start checkout. Nothing was charged.' });
    }
});

/** POST /portal -> { url }  (Stripe's page to update a card, switch plan or cancel) */
router.post('/portal', requireManager, async (req, res) => {
    try {
        const stripe = getStripe();
        if (!stripe) return res.status(503).json({ error: 'Online payment is not switched on yet.' });
        const rows = await db.loadEntitlements(supabaseAdmin, req.billingCompany.id);
        const customerId = rows.find(r => r.source === 'paid' && r.stripe_customer_id)?.stripe_customer_id;
        if (!customerId) return res.status(404).json({ error: 'There is no paid subscription to manage yet.' });
        const origin = `${req.protocol}://${req.get('host')}`;
        const session = await createPortalSession(stripe, {
            customerId, returnUrl: `${origin}/store/${encodeURIComponent(req.billingCompany.slug)}`
        });
        res.json({ url: session.url });
    } catch (err) {
        console.error('Billing portal error:', err);
        res.status(500).json({ error: 'Could not open billing.' });
    }
});

module.exports = router;
