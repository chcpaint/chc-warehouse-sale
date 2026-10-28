/**
 * tests/billing.test.js
 *
 * Subscriptions for the optional parts of the console: price list, free vs
 * paid customers, $0 grants by a super admin, Stripe Checkout, webhooks, and the
 * rule that a paid customer only gets the modules they are entitled to.
 *
 *   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

// middleware/auth.js is required for real below (to capture its
// implementation before Module._load is overridden — see the file header),
// which transitively requires the real utils/supabase.js. That module exits
// the process if these are unset; the values never have to be reachable
// because supabaseAdmin itself is stubbed out for every actual call.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.invalid';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'service-key';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { createFakeSupabase } = require('./helpers/fake-supabase');

const ROOT = path.resolve(__dirname, '..');
let fake = createFakeSupabase();

const supabaseProxy = new Proxy({}, {
    get: (_t, prop) => {
        const v = fake[prop];
        return typeof v === 'function' ? v.bind(fake) : v;
    }
});

let authAdmin = null;
let authCompany = null;
let authCompanyUser = null;
let stripeFake = null;
const stripeCalls = { checkout: [], portal: [] };
function makeStripe() {
    return {
        checkout: { sessions: { create: async (p) => { stripeCalls.checkout.push(p); return { id: 'cs_1', url: 'https://checkout.example/cs_1' }; } } },
        billingPortal: { sessions: { create: async (p) => { stripeCalls.portal.push(p); return { url: 'https://portal.example/p' }; } } }
    };
}

const sentEmails = { status: [], notes: [], notifications: [] };

// utils/order-scope.js is deliberately NOT stubbed (see file header — real
// requireOrderAccess is what's under test), so it must resolve utils/supabase
// to the fake too. That means the fake has to be wired in via Module._load
// BEFORE middleware/auth.js is ever required — including the require below
// that captures its real implementation — or order-scope's internal
// `require('./supabase')` picks up the genuine client instead and every
// order-scoped call hangs against https://example.invalid.
const stubs = {
    [path.join(ROOT, 'utils/supabase.js')]: { supabaseAdmin: supabaseProxy },
    [path.join(ROOT, 'utils/sanitize.js')]: {
        stripHtml: s => String(s === undefined || s === null ? '' : s).replace(/<[^>]*>/g, ''),
        sanitizeObject: o => o,
        isValidUUID: v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '')),
        generateSlug: s => s,
        validateEmail: () => true
    },
    [path.join(ROOT, 'utils/email.js')]: {
        sendOrderNotification: async (o) => { sentEmails.notifications.push(o); return { sent: true }; },
        sendOrderStatusUpdate: async (o) => { sentEmails.status.push(o); return { sent: true }; },
        sendOrderNoteAdded: async (o) => { sentEmails.notes.push(o); return { sent: true }; },
        sendInvoiceReady: async () => ({ sent: true }),
        sendOrderClosed: async () => ({ sent: true }),
        sendLowStockAlert: async () => ({ sent: true }),
        sendReorderRaised: async () => ({ sent: true }),
        sendInvite: async () => ({ sent: true })
    },
    [path.join(ROOT, 'middleware/upload.js')]: {
        catalogUpload: { single: () => (req, res, next) => next() },
        logoUpload: { single: () => (req, res, next) => next() },
        invoiceUpload: { single: () => (req, res, next) => next() }
    },
    [path.join(ROOT, 'utils/payments.js')]: {
        paymentsEnabled: () => false,
        publicPaymentConfig: () => ({ enabled: false }),
        getStripe: () => stripeFake
    }
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (parent && request.startsWith('.')) {
        const resolved = path.resolve(path.dirname(parent.filename), request);
        for (const key of Object.keys(stubs)) {
            if (key === resolved || key === resolved + '.js') return stubs[key];
        }
    }
    return originalLoad.call(this, request, parent, isMain);
};

// NOW safe to load the real middleware/auth.js — the override above is
// already active, so its internal requires (order-scope -> supabase) land on
// the fake. Captured so the stub added below can carry restrictOrderDesk,
// requireOrderAccess and ORDER_DESK_ALLOW through unmodified, replacing only
// the two entry points that normally verify a JWT.
const realAuth = require('../middleware/auth');
stubs[path.join(ROOT, 'middleware/auth.js')] = {
    ...realAuth,
    requireAdminAuth: (req, res, next) => {
        if (!authAdmin) return res.status(401).json({ error: 'Admin access denied.' });
        req.admin = authAdmin;
        next();
    },
    requireCompanyAuth: (req, res, next) => {
        if (!authCompany) return res.status(401).json({ error: 'Not authenticated.' });
        req.company = authCompany;
        req.companyUser = authCompanyUser;
        next();
    }
};

const express = require('express');
const request = require('supertest');
const adminRoutes = require('../routes/admin');
const storefrontRoutes = require('../routes/storefront');

const CHC_ID = 'c0000000-0000-4000-8000-000000000001';
const CO = '11111111-1111-4111-8111-111111111111';
const BRANCH_MARKHAM = 'd0000000-0000-4000-8000-000000000001';
const BRANCH_OTHER = 'd0000000-0000-4000-8000-000000000002';
const LOC = '33333333-3333-4333-8333-333333333333';
const PRODUCT = '55555555-5555-4555-8555-555555555555';
const ORDER = 'e0000000-0000-4000-8000-000000000001';

const SUPER_ADMIN = { id: 'a1111111-1111-4111-8111-111111111111', role: 'super_admin', name: 'Sam Super', email: 'sam@chc.example', company_id: null, branch_id: null };
const ORDER_DESK_MARKHAM = { id: 'a2222222-2222-4222-8222-222222222222', role: 'order_desk', name: 'Dana Desk', email: 'dana@chc.example', company_id: null, branch_id: BRANCH_MARKHAM };
const ORDER_DESK_OTHER = { id: 'a3333333-3333-4333-8333-333333333333', role: 'order_desk', name: 'Otto Other', email: 'otto@chc.example', company_id: null, branch_id: BRANCH_OTHER };
const ORDER_MANAGER = { id: 'a4444444-4444-4444-8444-444444444444', role: 'order_manager', name: 'Mo Manager', email: 'mo@chc.example', company_id: null, branch_id: null };




const B = require('../utils/billing');
const db = require('../utils/billing-db');
const { moduleSettings, moduleEnabled, canSetModule } = require('../utils/modules');

const OTHER_DIST = 'c0000000-0000-4000-8000-0000000000bb';
const OTHER_CO = '12121212-1212-4212-8212-121212121212';
const OWNER = { id: 'u1111111-1111-4111-8111-111111111111', role: 'owner', name: 'Olive Owner', email: 'olive@shop.example' };
const MEMBER = { id: 'u2222222-2222-4222-8222-222222222222', role: 'member', name: 'Max Member', email: 'max@shop.example' };

function reset(opts = {}) {
    fake = createFakeSupabase({
        distributors: [
            { id: CHC_ID, name: 'CHC Paint', slug: 'chc', custom_domain: null, is_active: true, is_default: true, settings: opts.distSettings || {},
              stripe_account_id: opts.connect ? 'acct_123' : null, stripe_connect_status: opts.connect ? 'active' : 'not_connected' },
            { id: OTHER_DIST, name: 'Other Dist', slug: 'other', is_active: true, is_default: false, settings: {}, stripe_account_id: null, stripe_connect_status: 'not_connected' }
        ],
        companies: [
            { id: CO, distributor_id: CHC_ID, name: 'Assured Collision', slug: 'assured', is_active: true, contact_email: 'shop@example.invalid', email_config: {}, settings: opts.companySettings || {} },
            { id: OTHER_CO, distributor_id: OTHER_DIST, name: 'Elsewhere Autobody', slug: 'elsewhere', is_active: true, contact_email: 'x@example.invalid', email_config: {}, settings: {} }
        ],
        company_locations: [
            { id: LOC, company_id: CO, name: 'Main', is_active: true, supplier_branch_id: BRANCH_MARKHAM, notify_emails: [], restrict_to_category: null },
            { id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', company_id: CO, name: 'North', is_active: true, supplier_branch_id: BRANCH_MARKHAM, notify_emails: [], restrict_to_category: null }
        ],
        supplier_branches: [{ id: BRANCH_MARKHAM, name: 'Markham', emails: ['markham@chc.example'], is_active: true }],
        company_users: [{ id: OWNER.id, company_id: CO, name: OWNER.name, email: OWNER.email, role: 'owner', is_active: true },
                        { id: MEMBER.id, company_id: CO, name: MEMBER.name, email: MEMBER.email, role: 'member', is_active: true }],
        company_user_groups: [], billing_prices: opts.prices || [], company_entitlements: opts.entitlements || [], billing_events: [], audit_log: []
    });
    authAdmin = { ...SUPER_ADMIN, distributor_id: CHC_ID };
    authCompany = { id: CO, name: 'Assured Collision', slug: 'assured' };
    authCompanyUser = OWNER;
    stripeFake = makeStripe();
    stripeCalls.checkout = []; stripeCalls.portal = [];
}

function app() {
    const a = express();
    a.use(express.json());
    a.use((req, res, next) => {
        const d = fake.db.distributors[0];
        req.distributor = d ? { id: d.id, name: d.name, slug: d.slug, settings: d.settings } : null;
        next();
    });
    a.use('/api/admin', adminRoutes);
    a.use('/api/store', storefrontRoutes);
    return a;
}
const row = (o) => ({ id: 'e' + Math.random().toString(16).slice(2, 10), company_id: CO, distributor_id: CHC_ID, item: 'inventory', status: 'active', source: 'paid', interval: 'month', quantity: 1, unit_amount_cents: 12900, currency: 'cad', ...o });
const paid = { billing: { mode: 'paid', entitled: [] } };
const company = () => fake.db.companies.find(c => c.id === CO);

// ---------- pure rules ----------
test('default prices: annual is ten months; a distributor row beats a platform row beats the default', () => {
    const p = B.resolvePrices([], null, 'CA');
    assert.equal(p.inventory.month, 12900); assert.equal(p.inventory.year, 129000); assert.equal(p.inventory.currency, 'cad');
    const rows = [{ item: 'inventory', interval: 'month', unit_amount_cents: 10000, distributor_id: null, currency: 'cad' },
                  { item: 'inventory', interval: 'month', unit_amount_cents: 9000, distributor_id: CHC_ID, currency: 'usd' }];
    const q = B.resolvePrices(rows, CHC_ID, 'US');
    assert.equal(q.inventory.month, 9000); assert.equal(q.inventory.overridden.month, true); assert.equal(q.inventory.currency, 'usd');
    assert.equal(B.resolvePrices(rows, OTHER_DIST, 'CA').inventory.month, 10000);
});
test('quote: per-location items scale with locations, People & activity is per company', () => {
    const p = B.resolvePrices([], null, 'CA');
    const q = B.quote({ items: ['inventory', 'people'], interval: 'month', locations: 3, prices: p });
    assert.equal(q.lines.find(l => l.item === 'inventory').amount_cents, 3 * 12900);
    assert.equal(q.lines.find(l => l.item === 'people').amount_cents, 3900);
    assert.equal(q.total_cents, 3 * 12900 + 3900);
});
test('quote: the bundle replaces its pieces, kits need inventory, owned items are not charged twice', () => {
    const p = B.resolvePrices([], null, 'CA');
    const b = B.quote({ items: ['complete', 'inventory'], interval: 'year', locations: 2, prices: p });
    assert.deepEqual(b.lines.map(l => l.item), ['complete']); assert.equal(b.total_cents, 2 * 199000);
    assert.equal(B.quote({ items: ['kits'], interval: 'month', locations: 1, prices: p }).ok, false);
    assert.equal(B.quote({ items: ['kits'], interval: 'month', locations: 1, prices: p, owned: ['inventory'] }).ok, true);
    assert.equal(B.quote({ items: ['inventory'], interval: 'month', locations: 1, prices: p, owned: ['inventory'] }).ok, false);
    assert.ok(B.quote({ items: ['inventory', 'kits', 'people', 'shopsafe'], interval: 'month', locations: 1, prices: p }).bundle_saves_cents > 0);
    assert.equal(B.quote({ items: [], interval: 'month', locations: 1, prices: p }).ok, false);
    assert.equal(B.quote({ items: ['inventory'], interval: 'week', locations: 1, prices: p }).ok, false);
    assert.equal(B.quote({ items: ['inventory'], interval: 'month', locations: 0, prices: p }).ok, false);
});
test('a free-mode company is never affected; a paid one only gets what it is entitled to', () => {
    const on = { inventory: { enabled: true }, kits: { enabled: true }, activity: { enabled: true }, users: { enabled: true }, shopsafe: { enabled: true }, hide_pricing: { enabled: true } };
    assert.equal(moduleEnabled(on, 'inventory'), true);
    const locked = { ...on, billing: { mode: 'paid', entitled: [] } };
    for (const m of ['inventory', 'kits', 'activity', 'shopsafe']) assert.equal(moduleEnabled(locked, m), false, m);
    assert.equal(moduleEnabled(locked, 'users'), true, 'individual logins stay free');
    assert.equal(moduleEnabled(locked, 'hide_pricing'), true);
    const some = { ...on, billing: { mode: 'paid', entitled: ['inventory', 'kits'] } };
    assert.equal(moduleEnabled(some, 'inventory'), true); assert.equal(moduleEnabled(some, 'kits'), true); assert.equal(moduleEnabled(some, 'shopsafe'), false);
    assert.equal(moduleSettings(on, 'inventory').enabled, true);
});
test('turning a module on for a paid customer without the item is refused with a clear message', () => {
    const r = canSetModule({ billing: { mode: 'paid', entitled: [] } }, 'inventory', true);
    assert.equal(r.ok, false); assert.match(r.error, /not subscribed/);
    assert.equal(canSetModule({ billing: { mode: 'paid', entitled: ['inventory'] } }, 'inventory', true).ok, true);
    assert.equal(canSetModule({ billing: { mode: 'paid', entitled: [] } }, 'inventory', false).ok, true, 'turning off is always allowed');
});
test('entitlements: bundles expand, canceled rows and expired comps do not count', () => {
    const rows = [row({ item: 'complete' }), row({ item: 'inventory', status: 'canceled' }), row({ item: 'people', source: 'comp', status: 'comped', comp_until: '2020-01-01T00:00:00Z' })];
    assert.deepEqual(B.entitledItems(rows), ['inventory', 'kits', 'people', 'shopsafe']);
    assert.deepEqual(B.entitledItems([row({ item: 'inventory', status: 'canceled' })]), []);
    assert.deepEqual(B.entitledItems([row({ item: 'people', source: 'comp', status: 'comped', comp_until: '2020-01-01T00:00:00Z' })]), []);
    assert.deepEqual(B.entitledItems([row({ status: 'past_due' })]), ['inventory'], 'a late payment gets a grace period');
});

// ---------- admin: prices ----------
test('GET /billing/prices lists every item with the standard price', async () => {
    reset();
    const res = await request(app()).get('/api/admin/billing/prices');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.items.length, 5); assert.equal(res.body.currency, 'cad');
    assert.equal(res.body.items.find(i => i.item === 'complete').month_cents, 19900);
});
test('a US distributor is priced in USD', async () => {
    reset({ distSettings: { tax: { country: 'US', region: 'TX', rate: 0.0825, rates: { TX: 0.0825 } } } });
    assert.equal((await request(app()).get('/api/admin/billing/prices')).body.currency, 'usd');
});
test('setting, zeroing and resetting a price is saved, audited and validated', async () => {
    reset();
    const set = await request(app()).put('/api/admin/billing/prices').send({ item: 'inventory', interval: 'month', amount: 99 });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(fake.db.billing_prices[0].unit_amount_cents, 9900); assert.equal(fake.db.billing_prices[0].distributor_id, CHC_ID);
    assert.equal((await request(app()).get('/api/admin/billing/prices')).body.items[0].month_cents, 9900);
    assert.equal((await request(app()).put('/api/admin/billing/prices').send({ item: 'inventory', interval: 'month', amount: 0 })).status, 200);
    assert.equal(fake.db.billing_prices[0].unit_amount_cents, 0);
    assert.equal((await request(app()).put('/api/admin/billing/prices').send({ item: 'inventory', interval: 'month', amount: null })).status, 200);
    assert.equal(fake.db.billing_prices.length, 0);
    assert.equal((await request(app()).put('/api/admin/billing/prices').send({ item: 'nope', interval: 'month', amount: 5 })).status, 400);
    assert.equal((await request(app()).put('/api/admin/billing/prices').send({ item: 'inventory', interval: 'month', amount: -5 })).status, 400);
    assert.ok(fake.db.audit_log.some(a => a.action === 'billing_price_set'));
});
test('only a super admin can use the billing console', async () => {
    for (const who of [ORDER_DESK_MARKHAM, ORDER_MANAGER, { ...SUPER_ADMIN, role: 'admin', company_id: CO }]) {
        reset(); authAdmin = who;
        assert.equal((await request(app()).get('/api/admin/billing/prices')).status, 403, who.role);
        assert.equal((await request(app()).post(`/api/admin/billing/companies/${CO}/comp`).send({ items: ['inventory'], reason: 'test' })).status, 403, who.role);
    }
});

// ---------- admin: free vs paid, $0 grants ----------
test('switching a customer who uses nothing optional to paid just works', async () => {
    reset();
    const res = await request(app()).put(`/api/admin/billing/companies/${CO}/mode`).send({ mode: 'paid' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(company().settings.billing.mode, 'paid');
    assert.equal(company().settings.purchase_orders, undefined);
});
test('moving a customer who uses Inventory to paid warns first, then can keep it free or switch it off', async () => {
    reset({ companySettings: { inventory: { enabled: true } } });
    const warn = await request(app()).put(`/api/admin/billing/companies/${CO}/mode`).send({ mode: 'paid' });
    assert.equal(warn.status, 409); assert.deepEqual(warn.body.affected_modules, ['inventory']);
    assert.equal(company().settings.billing, undefined, 'nothing changed by the warning');

    const keep = await request(app()).put(`/api/admin/billing/companies/${CO}/mode`).send({ mode: 'paid', grandfather: true });
    assert.equal(keep.status, 200, JSON.stringify(keep.body));
    assert.equal(moduleEnabled(company().settings, 'inventory'), true);
    assert.equal(fake.db.company_entitlements[0].source, 'comp'); assert.match(fake.db.company_entitlements[0].comp_reason, /billing was switched on/);

    reset({ companySettings: { inventory: { enabled: true } } });
    const off = await request(app()).put(`/api/admin/billing/companies/${CO}/mode`).send({ mode: 'paid', confirm: true });
    assert.equal(off.status, 200);
    assert.equal(moduleEnabled(company().settings, 'inventory'), false);
});
test('a super admin can give items free ($0) with a reason, and the modules work at once', async () => {
    reset({ companySettings: { ...paid, inventory: { enabled: true }, kits: { enabled: true } } });
    assert.equal(moduleEnabled(company().settings, 'inventory'), false);
    const res = await request(app()).post(`/api/admin/billing/companies/${CO}/comp`).send({ items: ['inventory', 'kits'], reason: 'Founding partner' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.granted.sort(), ['inventory', 'kits']);
    assert.equal(moduleEnabled(company().settings, 'inventory'), true); assert.equal(moduleEnabled(company().settings, 'kits'), true);
    assert.ok(fake.db.company_entitlements.every(r => r.unit_amount_cents === 0 && r.source === 'comp' && r.comp_reason === 'Founding partner'));
    assert.ok(fake.db.audit_log.some(a => a.action === 'billing_comp_granted'));
    assert.equal(company().settings.inventory.enabled, true, 'their own settings are untouched');
});
test('a free grant needs a reason, a future end date and a real item', async () => {
    reset();
    const url = `/api/admin/billing/companies/${CO}/comp`;
    assert.equal((await request(app()).post(url).send({ items: ['inventory'] })).status, 400);
    assert.equal((await request(app()).post(url).send({ items: ['inventory'], reason: 'x' })).status, 400);
    assert.equal((await request(app()).post(url).send({ items: [], reason: 'because' })).status, 400);
    assert.equal((await request(app()).post(url).send({ items: ['nope'], reason: 'because' })).status, 400);
    assert.equal((await request(app()).post(url).send({ items: ['inventory'], reason: 'because', until: '2020-01-01' })).status, 400);
    assert.equal(fake.db.company_entitlements.length, 0);
});
test('a free grant never overwrites something the customer pays for, and can be taken away', async () => {
    reset({ companySettings: { ...paid }, entitlements: [row({ stripe_subscription_id: 'sub_1' })] });
    const res = await request(app()).post(`/api/admin/billing/companies/${CO}/comp`).send({ items: ['inventory', 'people'], reason: 'goodwill' });
    assert.deepEqual(res.body.granted, ['people']); assert.deepEqual(res.body.skipped, ['inventory']);
    assert.equal(fake.db.company_entitlements.find(r => r.item === 'inventory').source, 'paid');
    const del = await request(app()).delete(`/api/admin/billing/companies/${CO}/comp/people`);
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal(fake.db.company_entitlements.find(r => r.item === 'people'), undefined);
    assert.equal((await request(app()).delete(`/api/admin/billing/companies/${CO}/comp/inventory`)).status, 404, 'cannot remove a paid row this way');
});
test('GET /billing/companies reports each customer and the recurring revenue', async () => {
    reset({ companySettings: paid, entitlements: [row({ quantity: 2, stripe_subscription_id: 'sub_1' }), row({ item: 'people', source: 'comp', status: 'comped', unit_amount_cents: 0 }), row({ item: 'kits', interval: 'year', unit_amount_cents: 49000, status: 'active' })] });
    const res = await request(app()).get('/api/admin/billing/companies');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.companies.length, 1, 'only this distributor\'s customers');
    assert.equal(res.body.companies[0].mode, 'paid');
    assert.equal(res.body.companies[0].monthly_cents, 2 * 12900 + Math.round(49000 / 12));
    assert.equal(res.body.summary.comped_items, 1); assert.equal(res.body.summary.mrr_cents, res.body.companies[0].monthly_cents);
});

// ---------- tenant fence ----------
test('a super admin of one distributor cannot reach another distributor\'s company', async () => {
    reset();
    for (const url of [`/api/admin/billing/companies/${OTHER_CO}/comp`]) {
        assert.equal((await request(app()).post(url).send({ items: ['inventory'], reason: 'sneaky' })).status, 404);
    }
    assert.equal((await request(app()).put(`/api/admin/billing/companies/${OTHER_CO}/mode`).send({ mode: 'paid' })).status, 404);
    assert.equal((await request(app()).get(`/api/admin/companies/${OTHER_CO}/tax`)).status, 404);
    assert.equal((await request(app()).put(`/api/admin/companies/${OTHER_CO}/tax`).send({ exempt: true })).status, 404);
    assert.equal(fake.db.companies.find(c => c.id === OTHER_CO).settings.tax, undefined);
    assert.equal((await request(app()).get(`/api/admin/companies/${CO}/tax`)).status, 200, 'own company still fine');
});

// ---------- customer side ----------
const STORE = '/api/store/assured/billing';
test('anyone signed in can see the plans; only the owner can manage them', async () => {
    reset();
    let res = await request(app()).get(`${STORE}/plans`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.can_manage, true); assert.equal(res.body.locations, 2); assert.equal(res.body.items.length, 5);
    assert.match(res.body.free.blurb, /Always free/);
    authCompanyUser = MEMBER;
    res = await request(app()).get(`${STORE}/plans`);
    assert.equal(res.body.can_manage, false);
    assert.equal((await request(app()).post(`${STORE}/checkout`).send({ items: ['inventory'], interval: 'month' })).status, 403);
    assert.equal(stripeCalls.checkout.length, 0);
});
test('the shared company login can buy only when the company does not use individual logins', async () => {
    reset(); authCompanyUser = null;
    assert.equal((await request(app()).get(`${STORE}/plans`)).body.can_manage, true);
    reset({ companySettings: { users: { enabled: true } } }); authCompanyUser = null;
    assert.equal((await request(app()).get(`${STORE}/plans`)).body.can_manage, false);
});
test('quote uses the company\'s location count by default and the distributor\'s prices', async () => {
    reset({ prices: [{ distributor_id: CHC_ID, item: 'inventory', interval: 'month', unit_amount_cents: 10000, currency: 'cad' }] });
    const res = await request(app()).post(`${STORE}/quote`).send({ items: ['inventory'], interval: 'month' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.total_cents, 20000); assert.equal(res.body.locations, 2);
    assert.equal((await request(app()).post(`${STORE}/quote`).send({ items: ['kits'], interval: 'month' })).status, 400);
});
test('checkout opens Stripe with the right amounts, and records who it is for', async () => {
    reset();
    const res = await request(app()).post(`${STORE}/checkout`).send({ items: ['inventory', 'people'], interval: 'year' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.url, 'https://checkout.example/cs_1');
    const p = stripeCalls.checkout[0];
    assert.equal(p.mode, 'subscription'); assert.equal(p.client_reference_id, CO);
    assert.equal(p.line_items[0].quantity, 2); assert.equal(p.line_items[0].price_data.unit_amount, 129000);
    assert.equal(p.line_items[0].price_data.recurring.interval, 'year'); assert.equal(p.line_items[0].price_data.currency, 'cad');
    assert.equal(p.line_items[1].quantity, 1); assert.equal(p.line_items[1].price_data.unit_amount, 39000);
    assert.equal(p.metadata.company_id, CO); assert.equal(p.metadata.lines, 'inventory:2:129000,people:1:39000');
    assert.match(p.success_url, /\/store\/assured\?billing=success$/);
    assert.equal(p.subscription_data.transfer_data, undefined, 'no connected account: the platform collects');
    assert.equal(fake.db.company_entitlements.length, 0, 'nothing is switched on until Stripe confirms payment');
});
test('with a connected distributor account the money goes to them, less an optional platform fee', async () => {
    reset({ connect: true, distSettings: { billing: { platform_fee_percent: 10 } } });
    await request(app()).post(`${STORE}/checkout`).send({ items: ['inventory'], interval: 'month', locations: 1 });
    const sub = stripeCalls.checkout[0].subscription_data;
    assert.equal(sub.transfer_data.destination, 'acct_123'); assert.equal(sub.application_fee_percent, 10);
});
test('checkout without Stripe configured says so and charges nothing', async () => {
    reset(); stripeFake = null;
    const res = await request(app()).post(`${STORE}/checkout`).send({ items: ['inventory'], interval: 'month' });
    assert.equal(res.status, 503); assert.match(res.body.error, /not switched on/);
});
test('items the distributor priced at $0 switch on with no payment', async () => {
    reset({ companySettings: paid, prices: [{ distributor_id: CHC_ID, item: 'inventory', interval: 'month', unit_amount_cents: 0, currency: 'cad' }] });
    const res = await request(app()).post(`${STORE}/checkout`).send({ items: ['inventory'], interval: 'month' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.activated, true); assert.equal(stripeCalls.checkout.length, 0);
    assert.equal(fake.db.company_entitlements[0].source, 'free_price');
    assert.equal(company().settings.billing.entitled.includes('inventory'), true);
});
test('the billing portal needs a paid subscription and an owner', async () => {
    reset();
    assert.equal((await request(app()).post(`${STORE}/portal`).send({})).status, 404);
    reset({ entitlements: [row({ stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' })] });
    const res = await request(app()).post(`${STORE}/portal`).send({});
    assert.equal(res.status, 200); assert.equal(stripeCalls.portal[0].customer, 'cus_1');
    authCompanyUser = MEMBER;
    assert.equal((await request(app()).post(`${STORE}/portal`).send({})).status, 403);
});

// ---------- Stripe webhook events ----------
const checkoutDone = (o = {}) => ({ id: 'evt_1', type: 'checkout.session.completed', data: { object: {
    mode: 'subscription', payment_status: 'paid', customer: 'cus_1', subscription: 'sub_1', currency: 'cad',
    metadata: { kind: 'console_subscription', company_id: CO, distributor_id: CHC_ID, interval: 'month', lines: 'inventory:2:12900,people:1:3900' }, ...o } } });
const subEvent = (status, id = 'evt_2', extra = {}) => ({ id, type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status, current_period_end: 1893456000, cancel_at_period_end: false, ...extra } } });

test('a paid checkout switches the items on, once, even if Stripe sends the event twice', async () => {
    reset({ companySettings: { ...paid, inventory: { enabled: true } } });
    const r1 = await db.handleStripeEvent(fake, checkoutDone());
    assert.equal(r1.handled, true);
    assert.deepEqual(fake.db.company_entitlements.map(r => [r.item, r.status, r.source, r.quantity]).sort(), [['inventory', 'active', 'paid', 2], ['people', 'active', 'paid', 1]]);
    assert.equal(moduleEnabled(company().settings, 'inventory'), true);
    const r2 = await db.handleStripeEvent(fake, checkoutDone());
    assert.equal(r2.duplicate, true); assert.equal(fake.db.company_entitlements.length, 2); assert.equal(fake.db.billing_events.length, 1);
});
test('past due keeps access for now; canceled or unpaid switches the modules off', async () => {
    reset({ companySettings: { ...paid, inventory: { enabled: true } } });
    await db.handleStripeEvent(fake, checkoutDone());
    await db.handleStripeEvent(fake, subEvent('past_due', 'evt_3'));
    assert.equal(fake.db.company_entitlements[0].status, 'past_due'); assert.ok(fake.db.company_entitlements[0].current_period_end);
    assert.equal(moduleEnabled(company().settings, 'inventory'), true);
    await db.handleStripeEvent(fake, subEvent('canceled', 'evt_4'));
    assert.equal(moduleEnabled(company().settings, 'inventory'), false);
    await db.handleStripeEvent(fake, subEvent('active', 'evt_5', { cancel_at_period_end: true }));
    assert.equal(moduleEnabled(company().settings, 'inventory'), true); assert.equal(fake.db.company_entitlements[0].cancel_at_period_end, true);
});
test('webhook events that do not add up are ignored: unpaid session, wrong distributor, unknown company, someone else\'s subscription', async () => {
    reset({ companySettings: paid });
    assert.equal((await db.handleStripeEvent(fake, checkoutDone({ payment_status: 'unpaid' }))).handled, false);
    const wrong = checkoutDone(); wrong.id = 'evt_x'; wrong.data.object.metadata.distributor_id = OTHER_DIST;
    assert.equal((await db.handleStripeEvent(fake, wrong)).handled, false);
    const nobody = checkoutDone(); nobody.id = 'evt_y'; nobody.data.object.metadata.company_id = '99999999-9999-4999-8999-999999999999';
    assert.equal((await db.handleStripeEvent(fake, nobody)).handled, false);
    const other = checkoutDone(); other.id = 'evt_z'; other.data.object.metadata.kind = 'something_else';
    assert.equal((await db.handleStripeEvent(fake, other)).handled, false);
    assert.equal((await db.handleStripeEvent(fake, subEvent('active', 'evt_w'))).handled, false);
    assert.equal(fake.db.company_entitlements.length, 0);
});
test('an event that fails part-way is not marked done, so Stripe\'s retry still works', async () => {
    reset({ companySettings: paid });
    const orig = fake.from.bind(fake); let boom = true;
    fake.from = (t) => { if (t === 'company_entitlements' && boom) { boom = false; throw new Error('db down'); } return orig(t); };
    await assert.rejects(() => db.handleStripeEvent(fake, checkoutDone()));
    assert.equal(fake.db.billing_events.length, 0);
    fake.from = orig;
    assert.equal((await db.handleStripeEvent(fake, checkoutDone())).handled, true);
});
