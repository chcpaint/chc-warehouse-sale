/**
 * tests/fees-rebates-admin.test.js
 *
 * The parts of the fee/rebate feature that live behind routes/admin.js and its
 * real auth rules: price edits re-applying fee rules, the CHC-wide rebate report,
 * who can reach the rule editor, and the order export.
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


const RULE_FEE = 'f1111111-1111-4111-8111-111111111111';

function reset(opts = {}) {
    fake = createFakeSupabase({
        distributors: [{ id: CHC_ID, name: 'CHC Paint & Auto Body Supplies', slug: 'chc', custom_domain: null, is_active: true, is_default: true, settings: { order_status_mode: 'simplified' } }],
        companies: [{ id: CO, distributor_id: CHC_ID, name: 'Assured Collision', slug: 'assured', is_active: true, contact_email: 'shop@example.invalid', email_config: {}, settings: opts.companySettings || {} }],
        company_locations: [{ id: LOC, company_id: CO, name: 'Main', is_active: true, supplier_branch_id: BRANCH_MARKHAM, notify_emails: [], restrict_to_category: null }],
        supplier_branches: [{ id: BRANCH_MARKHAM, name: 'Markham', emails: ['markham@chc.example'], is_active: true }],
        products: [{ id: PRODUCT, company_id: CO, sku: 'W-1', name: 'Widget', brand: '3M', category: 'Abrasives', price: 25, is_active: true, price_on_request: false }],
        company_fee_rules: opts.fee || [],
        company_rebate_rules: opts.rebate || [],
        company_user_groups: [], company_users: [],
        orders: [{
            id: ORDER, company_id: CO, order_number: 'CHC-1001', contact_name: 'Pat', contact_email: 'pat@example.invalid', contact_phone: '555',
            company_name: 'Assured Collision', location: 'Main', location_id: LOC,
            items: [{ product_id: PRODUCT, name: 'Widget', sku: 'W-1', quantity: 20, unit_price: 25, subtotal: 500, price_on_request: false }],
            subtotal: 500, tax: 0, tax_rate: 0, delivery_fee: 0, total: 500, notes: '', status: 'closed',
            status_history: [], is_partial_shipment: false, notes_log: [], created_at: '2026-09-15T15:00:00Z'
        }],
        audit_log: []
    });
    authAdmin = SUPER_ADMIN;
    authCompany = { id: CO, name: 'Assured Collision', slug: 'assured' };
    authCompanyUser = null;
}

function adminApp() {
    const a = express();
    a.use(express.json());
    // req.distributor is set directly rather than through the real
    // resolveDistributor middleware — these tests are about what admin.js
    // and storefront.js DO with req.distributor, not host resolution itself
    // (see tests/multi-tenant.test.js for that).
    a.use((req, res, next) => {
        const d = fake.db.distributors[0];
        req.distributor = d ? { id: d.id, name: d.name, slug: d.slug, settings: d.settings } : null;
        next();
    });
    a.use('/api/admin', adminRoutes);
    return a;
}


const fuelRule = (o) => ({ id: RULE_FEE, company_id: CO, kind: 'fuel', label: 'Fuel surcharge', calc: 'percent', amount: 4, condition: 'always',
    threshold: null, group_ids: [], is_active: true, created_at: '2026-01-01T00:00:00Z', ...o });
const rebateRule = (o) => ({ id: 'b1111111-1111-4111-8111-111111111111', company_id: CO, label: 'Assured rebate', percent: 5, applies_to: 'all',
    categories: [], brands: [], frequency: 'monthly', starts_on: null, ends_on: null, is_active: true, created_at: '2026-01-01T00:00:00Z', ...o });
const priceEdit = (items) => request(adminApp()).put(`/api/admin/companies/${CO}/orders/${ORDER}/items`).send({ items, reason: 'test' });

test('editing prices on an order re-applies the company fee rules (percent fuel surcharge on the new subtotal)', async () => {
    reset({ companySettings: { tax: { exempt: true } }, fee: [fuelRule({})] });
    const res = await priceEdit([{ name: 'Widget', sku: 'W-1', quantity: 10, unit_price: 20 }]); // $200
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.order.subtotal, 200);
    assert.equal(res.body.order.fuel_surcharge, 8);
    assert.equal(res.body.order.delivery_fee, 0);
    assert.equal(res.body.order.total, 208);
    assert.deepEqual(res.body.order.fee_lines.map(l => [l.kind, l.amount]), [['fuel', 8]]);
});
test('a company with its fee switched off stays at no fee after a price edit', async () => {
    reset({ companySettings: { tax: { exempt: true }, delivery_fee: { enabled: false } } });
    const res = await priceEdit([{ name: 'Widget', sku: 'W-1', quantity: 1, unit_price: 25 }]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.order.delivery_fee, 0);
    assert.equal(res.body.order.total, 25);
});

test('GET /reports/rebates: super admin sees every company with an active rebate', async () => {
    reset({ rebate: [rebateRule({})] });
    const res = await request(adminApp()).get('/api/admin/reports/rebates?from=2026-09-01T00:00:00Z&to=2026-09-30T23:59:59Z');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.companies.length, 1);
    assert.equal(res.body.companies[0].name, 'Assured Collision');
    assert.equal(res.body.companies[0].totals.eligible_spend, 500);
    assert.equal(res.body.companies[0].totals.rebate, 25);
    assert.equal(res.body.totals.rebate, 25);
});
test('a paused rebate is left out of the CHC report', async () => {
    reset({ rebate: [rebateRule({ is_active: false })] });
    const res = await request(adminApp()).get('/api/admin/reports/rebates');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.companies, []);
});
test('rebate report and fee/rebate rules are not reachable by order-desk or order-manager accounts', async () => {
    reset({ rebate: [rebateRule({})] });
    for (const who of [ORDER_DESK_MARKHAM, ORDER_MANAGER]) {
        authAdmin = who;
        assert.ok([401, 403].includes((await request(adminApp()).get('/api/admin/reports/rebates')).status), who.role);
        assert.ok([401, 403].includes((await request(adminApp()).get(`/api/admin/companies/${CO}/fees-rebates`)).status), who.role);
        assert.ok([401, 403].includes((await request(adminApp()).post(`/api/admin/companies/${CO}/fees-rebates/fee-rules`).send({ kind: 'delivery', calc: 'flat', amount: 5 })).status), who.role);
    }
});
test('the order export carries a Fuel Surcharge column', async () => {
    reset({});
    const res = await request(adminApp()).get('/api/admin/orders/export');
    assert.equal(res.status, 200);
    assert.match(res.text.split('\n')[0], /Delivery Fee,Fuel Surcharge,Total/i);
});
test('through the real admin router: create a fee rule, then the storefront order is charged it', async () => {
    reset({ companySettings: { tax: { exempt: true } } });
    const created = await request(adminApp()).post(`/api/admin/companies/${CO}/fees-rebates/fee-rules`)
        .send({ kind: 'delivery', calc: 'flat', amount: 20, condition: 'below', threshold: 300 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const res = await request(adminApp()).put(`/api/admin/companies/${CO}/orders/${ORDER}/items`).send({ items: [{ name: 'Widget', quantity: 2, unit_price: 25 }], reason: 'x' });
    assert.equal(res.body.order.delivery_fee, 20);
    assert.equal(res.body.order.total, 70);
});
