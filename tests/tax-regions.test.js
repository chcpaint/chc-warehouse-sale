/**
 * tests/tax-regions.test.js
 *
 * Canada / USA sales tax: a distributor picks its country, home province or
 * state and a rate, and every client company picks it up at checkout. A client
 * can still have its own rate, a region of its own, or be exempt.
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
        getStripe: () => null
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



const US_ID = 'c0000000-0000-4000-8000-0000000000aa';
const PRODUCT2 = PRODUCT;

function reset(opts = {}) {
    fake = createFakeSupabase({
        distributors: [{ id: CHC_ID, name: 'CHC Paint', slug: 'chc', custom_domain: null, is_active: true, is_default: true, settings: opts.distSettings || {} }],
        companies: [{ id: CO, distributor_id: CHC_ID, name: 'Assured Collision', slug: 'assured', is_active: true, contact_email: 'shop@example.invalid', email_config: {},
            settings: { purchase_orders: { mode: 'off' }, delivery_fee: { enabled: false }, ...(opts.companySettings || {}) } }],
        company_locations: [{ id: LOC, company_id: CO, name: 'Main', is_active: true, supplier_branch_id: BRANCH_MARKHAM, notify_emails: [], restrict_to_category: null }],
        supplier_branches: [{ id: BRANCH_MARKHAM, name: 'Markham', emails: ['markham@chc.example'], is_active: true }],
        products: [{ id: PRODUCT, company_id: CO, sku: 'W-1', name: 'Widget', brand: '3M', category: 'Abrasives', price: 100, is_active: true, price_on_request: false }],
        company_fee_rules: [], company_rebate_rules: [], company_user_groups: [], company_users: [], orders: [], audit_log: []
    });
    authAdmin = SUPER_ADMIN;
    authCompany = { id: CO, name: 'Assured Collision', slug: 'assured' };
    authCompanyUser = null;
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

const orderBody = { contact_name: 'Sam', contact_email: 'sam@example.invalid', contact_phone: '000', location_id: LOC, location: 'Main', items: [{ product_id: PRODUCT, quantity: 2 }] };
const placeOrder = () => request(app()).post('/api/store/assured/orders').send(orderBody);
const saveDist = (b) => request(app()).put('/api/admin/distributor-tax').send(b);
const TEXAS = { country: 'US', region: 'TX', rate: 0.0825, rates: { CA: 0.0725, FL: 0.07 } };

// ---------- unit: resolution order ----------
const { taxSettings } = require('../utils/tax');
const { COUNTRIES, findRegion } = require('../utils/tax-regions');

test('nothing configured anywhere stays on the 13% default', () => {
    const t = taxSettings({}, {});
    assert.equal(t.rate, 0.13); assert.equal(t.source, 'default'); assert.equal(t.is_default, true);
});
test('a distributor default rate applies to a client with no rate of its own', () => {
    const t = taxSettings({}, { tax: TEXAS });
    assert.equal(t.rate, 0.0825); assert.equal(t.source, 'distributor'); assert.equal(t.is_default, false); assert.equal(t.country, 'US');
});
test('a client tagged with a region gets that region\'s saved rate', () => {
    const t = taxSettings({ tax: { region: 'FL' } }, { tax: TEXAS });
    assert.equal(t.rate, 0.07); assert.equal(t.source, 'region'); assert.equal(t.region, 'FL');
});
test('a client region the distributor has no rate for falls back to the distributor default', () => {
    assert.equal(taxSettings({ tax: { region: 'NY' } }, { tax: TEXAS }).rate, 0.0825);
});
test('a client\'s own rate beats region and distributor; exempt beats everything', () => {
    assert.equal(taxSettings({ tax: { rate: 0.05, region: 'FL' } }, { tax: TEXAS }).rate, 0.05);
    const ex = taxSettings({ tax: { exempt: true, rate: 0.05, region: 'FL' } }, { tax: TEXAS });
    assert.equal(ex.rate, 0); assert.equal(ex.source, 'exempt');
});
test('malformed distributor tax data is ignored rather than trusted', () => {
    assert.equal(taxSettings({}, { tax: { country: 'XX', rate: 5, rates: { TX: 'lots', tx: 0.1 } } }).rate, 0.13);
});
test('every province and state has a code, a name and a rate between 0 and 1', () => {
    assert.equal(COUNTRIES.CA.regions.length, 13);
    assert.equal(COUNTRIES.US.regions.length, 51);
    for (const c of Object.values(COUNTRIES)) for (const r of c.regions) {
        assert.match(r.code, /^[A-Z]{2}$/); assert.ok(r.name); assert.ok(r.reference_rate >= 0 && r.reference_rate < 0.2);
    }
    assert.equal(findRegion('US', 'TX').name, 'Texas');
    assert.equal(findRegion('CA', 'TX'), null);
});

// ---------- distributor setup route ----------
test('GET /distributor-tax before setup reports not configured and lists both countries', async () => {
    reset();
    const res = await request(app()).get('/api/admin/distributor-tax');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.configured, false);
    assert.deepEqual(res.body.countries.map(c => c.code).sort(), ['CA', 'US']);
});
test('saving a Texas setup stores it, audits it and reads back', async () => {
    reset();
    const res = await saveDist(TEXAS);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.rate, 0.0825);
    assert.equal(res.body.rates.TX, 0.0825);
    assert.equal(fake.db.distributors[0].settings.tax.country, 'US');
    assert.equal(fake.db.distributors[0].settings.order_status_mode, undefined, 'unrelated settings untouched');
    assert.ok(fake.db.audit_log.some(a => a.action === 'distributor_tax_updated'));
    const get = await request(app()).get('/api/admin/distributor-tax');
    assert.equal(get.body.configured, true); assert.equal(get.body.region, 'TX'); assert.equal(get.body.rates.FL, 0.07);
});
test('saving without a rate uses the region\'s reference rate; other settings are preserved', async () => {
    reset({ distSettings: { order_status_mode: 'simplified' } });
    const res = await saveDist({ country: 'US', region: 'WA' });
    assert.equal(res.status, 200);
    assert.equal(res.body.rate, 0.065);
    assert.equal(fake.db.distributors[0].settings.order_status_mode, 'simplified');
});
test('bad input is refused: unknown country, region from the other country, bad rate, bad regional rate', async () => {
    reset();
    assert.equal((await saveDist({ country: 'MX', region: 'TX' })).status, 400);
    assert.equal((await saveDist({ country: 'CA', region: 'TX' })).status, 400);
    assert.equal((await saveDist({ country: 'US', region: 'TX', rate: 8.25 })).status, 400);
    assert.equal((await saveDist({ country: 'US', region: 'TX', rates: { ON: 0.13 } })).status, 400);
    assert.equal((await saveDist({ country: 'US', region: 'TX', rates: { FL: 'x' } })).status, 400);
    assert.deepEqual(fake.db.distributors[0].settings, {});
});
test('only a super admin can read or change the distributor tax setup', async () => {
    for (const who of [ORDER_DESK_MARKHAM, ORDER_MANAGER, { ...SUPER_ADMIN, role: 'admin', company_id: CO }]) {
        reset(); authAdmin = who;
        assert.equal((await request(app()).get('/api/admin/distributor-tax')).status, 403, who.role);
        assert.equal((await saveDist(TEXAS)).status, 403, who.role);
    }
});

// ---------- checkout ----------
test('a US distributor\'s client is charged the saved state rate at checkout', async () => {
    reset({ distSettings: { tax: TEXAS } });
    const res = await placeOrder();
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.order.subtotal, 200);
    assert.equal(res.body.order.tax_rate, 0.0825);
    assert.equal(res.body.order.tax, 16.5);
    assert.equal(res.body.order.total, 216.5);
});
test('a client tagged Florida pays Florida\'s rate; one tagged exempt pays nothing', async () => {
    reset({ distSettings: { tax: TEXAS }, companySettings: { tax: { region: 'FL' } } });
    assert.equal((await placeOrder()).body.order.tax, 14);
    reset({ distSettings: { tax: TEXAS }, companySettings: { tax: { exempt: true } } });
    assert.equal((await placeOrder()).body.order.tax, 0);
});
test('a distributor with no tax setup still charges the 13% default (nothing changes for CHC)', async () => {
    reset();
    const res = await placeOrder();
    assert.equal(res.body.order.tax_rate, 0.13);
    assert.equal(res.body.order.tax, 26);
});
test('the cart preview endpoint matches what the order will charge', async () => {
    reset({ distSettings: { tax: TEXAS } });
    const res = await request(app()).get('/api/store/assured/tax/config');
    assert.equal(res.status, 200);
    assert.equal(res.body.rate, 0.0825);
});

// ---------- company tax screen ----------
test('GET company tax shows the inherited rate, its source and the regions to pick from', async () => {
    reset({ distSettings: { tax: TEXAS } });
    const res = await request(app()).get(`/api/admin/companies/${CO}/tax`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.rate, 0.0825); assert.equal(res.body.source, 'distributor'); assert.equal(res.body.country, 'US');
    assert.equal(res.body.regions.length, 51); assert.equal(res.body.region_rates.FL, 0.07);
});
test('PUT company tax can set a region and then the distributor\'s rate for it applies', async () => {
    reset({ distSettings: { tax: TEXAS } });
    const res = await request(app()).put(`/api/admin/companies/${CO}/tax`).send({ region: 'fl' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.rate, 0.07); assert.equal(res.body.source, 'region'); assert.equal(res.body.region, 'FL');
    assert.equal(fake.db.companies[0].settings.tax.region, 'FL');
    assert.equal(fake.db.companies[0].settings.purchase_orders.mode, 'off', 'other company settings untouched');
});
test('PUT company tax refuses a region from the wrong country', async () => {
    reset({ distSettings: { tax: TEXAS } });
    const res = await request(app()).put(`/api/admin/companies/${CO}/tax`).send({ region: 'ON' });
    assert.equal(res.status, 400);
});
test('existing behaviour: company rate and exempt still save with no distributor setup', async () => {
    reset();
    const r1 = await request(app()).put(`/api/admin/companies/${CO}/tax`).send({ rate: 0.15 });
    assert.equal(r1.body.rate, 0.15); assert.equal(r1.body.source, 'company');
    const r2 = await request(app()).put(`/api/admin/companies/${CO}/tax`).send({ exempt: true });
    assert.equal(r2.body.exempt, true);
});
