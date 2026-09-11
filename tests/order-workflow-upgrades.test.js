/**
 * tests/order-workflow-upgrades.test.js
 *
 * The four features from the post-multi-tenant staff-feedback request:
 *   1. CHC's simplified order-status workflow (Received / Out for Delivery /
 *      Partial Shipment with Backorder / Closed), distributor-scoped.
 *   2. Staff price/line edits on an already-placed order, reachable by ANY
 *      staff role with access to the order (order_desk and order_manager
 *      included — "any staff of CHC").
 *   3. Per-company "hide pricing" (packing-slip) toggle: customers/delivery
 *      contacts see quantities only; CHC staff always keep full pricing.
 *   4. A running notes/messages log on an order, from either side, emailed
 *      to the other side.
 *
 * middleware/auth.js is used FOR REAL except for requireAdminAuth /
 * requireCompanyAuth themselves (which normally verify a JWT and reload the
 * account — every other test file in this suite injects req.admin/req.company
 * directly instead of minting tokens). That means restrictOrderDesk,
 * requireOrderAccess and ORDER_DESK_ALLOW — the actual access-control logic
 * this feature set depends on — run unmodified, including the order_manager
 * fix requireOrderAccess needed to make "any staff of CHC" true rather than
 * aspirational.
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

function baseOrder(overrides = {}) {
    return {
        id: ORDER, company_id: CO, order_number: 'CHC-1001',
        contact_name: 'Pat Painter', contact_email: 'pat@example.invalid', contact_phone: '555-0100',
        company_name: 'Assured Collision', location: 'Main', location_id: LOC,
        items: [
            { product_id: PRODUCT, name: 'Widget', sku: 'W-1', quantity: 2, unit_price: 25, subtotal: 50, price_on_request: false }
        ],
        subtotal: 50, tax: 6.5, tax_rate: 0.13, delivery_fee: 10, total: 66.5,
        notes: '', status: 'pending', status_history: [], is_partial_shipment: false, notes_log: [],
        ...overrides
    };
}

function reset(opts = {}) {
    fake = createFakeSupabase({
        distributors: [
            { id: CHC_ID, name: 'CHC Paint & Auto Body Supplies', slug: 'chc', custom_domain: null, is_active: true, is_default: true, settings: opts.distributorSettings ?? { order_status_mode: 'simplified' } }
        ],
        companies: [
            { id: CO, distributor_id: CHC_ID, name: 'Assured Collision', slug: 'assured', is_active: true, contact_email: 'shop@example.invalid', email_config: {}, settings: opts.companySettings || {} }
        ],
        company_locations: [
            { id: LOC, company_id: CO, name: 'Main', is_active: true, supplier_branch_id: BRANCH_MARKHAM, notify_emails: [], restrict_to_category: null }
        ],
        supplier_branches: [
            { id: BRANCH_MARKHAM, name: 'Markham', emails: ['markham@chc.example'], is_active: true },
            { id: BRANCH_OTHER, name: 'Other Branch', emails: ['other@chc.example'], is_active: true }
        ],
        products: [
            { id: PRODUCT, company_id: CO, sku: 'W-1', name: 'Widget', price: 25, is_active: true, price_on_request: false }
        ],
        orders: [baseOrder(opts.orderOverrides)],
        audit_log: []
    });
    authAdmin = SUPER_ADMIN;
    authCompany = { id: CO, name: 'Assured Collision', slug: 'assured' };
    authCompanyUser = null;
    sentEmails.status = []; sentEmails.notes = []; sentEmails.notifications = [];
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

function storeApp() {
    const a = express();
    a.use(express.json());
    a.use((req, res, next) => {
        const d = fake.db.distributors[0];
        req.distributor = d ? { id: d.id, name: d.name, slug: d.slug, settings: d.settings } : null;
        next();
    });
    a.use('/api/store', storefrontRoutes);
    return a;
}

// ==================================================================
// 1. Simplified status set + partial shipment flag + status emails
// ==================================================================

test('whoami exposes the simplified status set for a distributor in that mode', async () => {
    reset();
    const res = await request(adminApp()).get('/api/admin/whoami');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.order_status_options.map(o => o.value), ['pending', 'out_on_delivery', 'closed', 'cancelled']);
    assert.equal(res.body.order_status_options.find(o => o.value === 'pending').label, 'Received');
});

test('whoami falls back to the full status set with no distributor at all', async () => {
    reset();
    const a = express();
    a.use(express.json());
    a.use('/api/admin', adminRoutes); // no req.distributor middleware mounted
    const res = await request(a).get('/api/admin/whoami');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.order_status_options.map(o => o.value), ['pending', 'processing', 'out_on_delivery', 'closed', 'cancelled']);
});

test('setting Out for Delivery with the partial-shipment flag labels and stores it, and emails once', async () => {
    reset();
    const res = await request(adminApp())
        .put(`/api/admin/orders/${ORDER}/status`)
        .send({ status: 'out_on_delivery', is_partial_shipment: true, note: 'two cases short' });
    assert.equal(res.status, 200);
    assert.equal(res.body.order.is_partial_shipment, true);
    assert.equal(res.body.order.status_label, 'Partial Shipment with Backorder');

    assert.equal(sentEmails.status.length, 1);
    assert.equal(sentEmails.status[0].statusLabel, 'Partial Shipment with Backorder');
    assert.equal(sentEmails.status[0].isPartialShipment, true);
    // Both the orderer and the servicing branch are on the recipient list.
    assert.ok(sentEmails.status[0].to.includes('pat@example.invalid'));
    assert.ok(sentEmails.status[0].to.includes('markham@chc.example'));
});

test('closing an order emails "Closed" and does not carry the partial flag', async () => {
    reset({ orderOverrides: { status: 'out_on_delivery', is_partial_shipment: true } });
    const res = await request(adminApp())
        .put(`/api/admin/orders/${ORDER}/status`)
        .send({ status: 'closed' });
    assert.equal(res.status, 200);
    assert.equal(res.body.order.is_partial_shipment, false, 'the flag only ever applies to out_on_delivery');
    assert.equal(res.body.order.status_label, 'Closed');
    assert.equal(sentEmails.status.length, 1);
    assert.equal(sentEmails.status[0].statusLabel, 'Closed');
    assert.equal(sentEmails.status[0].isPartialShipment, false);
});

test('a distributor NOT in simplified mode gets the plain label and no status email', async () => {
    reset({ distributorSettings: {} });
    const res = await request(adminApp())
        .put(`/api/admin/orders/${ORDER}/status`)
        .send({ status: 'out_on_delivery' });
    assert.equal(res.status, 200);
    assert.equal(res.body.order.status_label, 'Out on Delivery');
    assert.equal(sentEmails.status.length, 0,
        'the simplified-status email is scoped to distributors that asked for it -- nothing changes for anyone else');
});

test('an unrecognized status is still rejected', async () => {
    reset();
    const res = await request(adminApp()).put(`/api/admin/orders/${ORDER}/status`).send({ status: 'shipped' });
    assert.equal(res.status, 400);
});

test('GET /orders and GET /reports/orders attach the distributor-aware status label', async () => {
    reset({ orderOverrides: { status: 'out_on_delivery', is_partial_shipment: true } });
    const list = await request(adminApp()).get('/api/admin/orders');
    assert.equal(list.body.orders[0].status_label, 'Partial Shipment with Backorder');
    const rep = await request(adminApp()).get('/api/admin/reports/orders');
    assert.equal(rep.body.orders[0].status_label, 'Partial Shipment with Backorder');
});

// ==================================================================
// 2. Staff price/item edits — "any staff of CHC"
// ==================================================================

test('a super admin can adjust pricing on an order, and totals are recomputed server-side', async () => {
    reset();
    const res = await request(adminApp())
        .put(`/api/admin/companies/${CO}/orders/${ORDER}/items`)
        .send({ items: [{ name: 'Widget', sku: 'W-1', quantity: 2, unit_price: 20 }], reason: 'price match' });
    assert.equal(res.status, 200);
    assert.equal(res.body.order.subtotal, 40);
    assert.equal(res.body.order.tax, Math.round(40 * 0.13 * 100) / 100);
    assert.equal(res.body.order.total, 40 + res.body.order.tax + res.body.order.delivery_fee);
    assert.equal(res.body.order.price_edited_by, SUPER_ADMIN.id);
    assert.ok(res.body.order.price_edited_at);
    assert.equal(res.body.order.price_edit_reason, 'price match');
    assert.ok(res.body.order.status_history.some(h => /Pricing adjusted by Sam Super: price match/.test(h.note)));
});

test('an order-desk account IN the right branch may edit pricing (in ORDER_DESK_ALLOW + requireOrderAccess)', async () => {
    reset();
    authAdmin = ORDER_DESK_MARKHAM;
    const res = await request(adminApp())
        .put(`/api/admin/companies/${CO}/orders/${ORDER}/items`)
        .send({ items: [{ name: 'Widget', quantity: 1, unit_price: 25 }] });
    assert.equal(res.status, 200);
});

test('an order-desk account in the WRONG branch is refused', async () => {
    reset();
    authAdmin = ORDER_DESK_OTHER;
    const res = await request(adminApp())
        .put(`/api/admin/companies/${CO}/orders/${ORDER}/items`)
        .send({ items: [{ name: 'Widget', quantity: 1, unit_price: 25 }] });
    assert.equal(res.status, 403);
});

test('an order_manager account may edit pricing on any branch\'s order — the requireOrderAccess fix', async () => {
    reset();
    authAdmin = ORDER_MANAGER;
    const res = await request(adminApp())
        .put(`/api/admin/companies/${CO}/orders/${ORDER}/items`)
        .send({ items: [{ name: 'Widget', quantity: 1, unit_price: 25 }] });
    assert.equal(res.status, 200,
        'order_manager is CHC staff with access to every order — "any staff of CHC" must include it');
});

test('an order_manager can also close and invoice orders now that requireOrderAccess recognizes the role', async () => {
    reset();
    authAdmin = ORDER_MANAGER;
    const res = await request(adminApp())
        .put(`/api/admin/companies/${CO}/orders/${ORDER}/close`)
        .send({});
    assert.equal(res.status, 200);
});

test('pricing edits reject an item with no name, a non-positive quantity, or a negative price', async () => {
    reset();
    for (const bad of [
        [{ name: '', quantity: 1, unit_price: 10 }],
        [{ name: 'X', quantity: 0, unit_price: 10 }],
        [{ name: 'X', quantity: 1, unit_price: -5 }]
    ]) {
        const res = await request(adminApp())
            .put(`/api/admin/companies/${CO}/orders/${ORDER}/items`)
            .send({ items: bad });
        assert.equal(res.status, 400);
    }
});

test('an empty items list is refused rather than silently emptying the order', async () => {
    reset();
    const res = await request(adminApp())
        .put(`/api/admin/companies/${CO}/orders/${ORDER}/items`)
        .send({ items: [] });
    assert.equal(res.status, 400);
});

// ==================================================================
// 3. Hide-pricing (packing slip) toggle
// ==================================================================

test('the hide_pricing module is off by default and can be turned on through the shared modules endpoint', async () => {
    reset();
    const status = await request(adminApp()).get(`/api/admin/companies/${CO}/modules`);
    const mod = status.body.modules.find(m => m.name === 'hide_pricing');
    assert.ok(mod, 'hide_pricing must be registered in utils/modules.js');
    assert.equal(mod.enabled, false);

    const on = await request(adminApp()).put(`/api/admin/companies/${CO}/modules/hide_pricing`).send({ enabled: true });
    assert.equal(on.status, 200);
    assert.equal(on.body.modules.find(m => m.name === 'hide_pricing').enabled, true);
});

test('with hide_pricing on, the customer-facing order list has no dollar figures, but the admin console keeps them', async () => {
    reset({ companySettings: { hide_pricing: { enabled: true } } });

    const customerView = await request(storeApp()).get('/api/store/assured/orders');
    assert.equal(customerView.status, 200);
    assert.equal(customerView.body.orders[0].total, null);
    assert.equal(customerView.body.orders[0].subtotal, null);
    assert.equal(customerView.body.orders[0].pricing_hidden, true);
    assert.equal(customerView.body.orders[0].items[0].unit_price, null);

    const staffView = await request(adminApp()).get('/api/admin/orders');
    assert.equal(staffView.status, 200);
    assert.equal(staffView.body.orders[0].total, 66.5, 'CHC staff always see full pricing regardless of the toggle');
});

test('order submission emails staff full pricing and the customer a packing slip when hide_pricing is on', async () => {
    reset({ companySettings: { hide_pricing: { enabled: true }, purchase_orders: { mode: 'off' }, delivery_fee: { enabled: false } } });
    authCompany = { id: CO, name: 'Assured Collision', slug: 'assured' };

    const res = await request(storeApp())
        .post('/api/store/assured/orders')
        .send({
            contact_name: 'Pat Painter', contact_email: 'pat@example.invalid', contact_phone: '555-0100',
            location_id: LOC, location: 'Main',
            items: [{ product_id: PRODUCT, quantity: 1 }]
        });
    assert.equal(res.status, 201);

    assert.equal(sentEmails.notifications.length, 2, 'a staff send and a separate customer send');
    const staffSend = sentEmails.notifications.find(o => o.to.includes('markham@chc.example'));
    const customerSend = sentEmails.notifications.find(o => o.to.includes('pat@example.invalid'));
    assert.ok(staffSend, 'the servicing branch must still be emailed');
    assert.equal(staffSend.hidePricing, false, 'staff always get full pricing');
    assert.ok(customerSend);
    assert.equal(customerSend.hidePricing, true);
});

test('order submission with hide_pricing OFF sends exactly one email to everyone, unchanged from before', async () => {
    reset({ companySettings: { purchase_orders: { mode: 'off' }, delivery_fee: { enabled: false } } });
    const res = await request(storeApp())
        .post('/api/store/assured/orders')
        .send({
            contact_name: 'Pat Painter', contact_email: 'pat@example.invalid', contact_phone: '555-0100',
            location_id: LOC, location: 'Main',
            items: [{ product_id: PRODUCT, quantity: 1 }]
        });
    assert.equal(res.status, 201);
    assert.equal(sentEmails.notifications.length, 1);
    assert.equal(sentEmails.notifications[0].hidePricing, undefined);
    assert.ok(sentEmails.notifications[0].to.includes('markham@chc.example'));
    assert.ok(sentEmails.notifications[0].to.includes('pat@example.invalid'));
});

// ==================================================================
// 4. Order notes, from either side
// ==================================================================

test('staff can add a note to an order, and the customer side is emailed (not the branch that wrote it)', async () => {
    reset();
    const res = await request(adminApp())
        .post(`/api/admin/companies/${CO}/orders/${ORDER}/notes`)
        .send({ text: 'Ready for pickup at the loading dock.' });
    assert.equal(res.status, 201);
    assert.equal(res.body.order.notes_log.length, 1);
    assert.equal(res.body.order.notes_log[0].from, 'staff');
    assert.equal(res.body.order.notes_log[0].text, 'Ready for pickup at the loading dock.');

    assert.equal(sentEmails.notes.length, 1);
    assert.ok(sentEmails.notes[0].to.includes('pat@example.invalid'));
    assert.ok(!sentEmails.notes[0].to.includes('markham@chc.example'));
});

test('an order-desk account outside the order\'s branch cannot add a note', async () => {
    reset();
    authAdmin = ORDER_DESK_OTHER;
    const res = await request(adminApp())
        .post(`/api/admin/companies/${CO}/orders/${ORDER}/notes`)
        .send({ text: 'trying anyway' });
    assert.equal(res.status, 403);
});

test('a blank note is refused', async () => {
    reset();
    const res = await request(adminApp())
        .post(`/api/admin/companies/${CO}/orders/${ORDER}/notes`)
        .send({ text: '   ' });
    assert.equal(res.status, 400);
});

test('a customer can add a note to their own order, and the servicing branch is emailed (not the customer)', async () => {
    reset();
    const res = await request(storeApp())
        .post(`/api/store/assured/orders/${ORDER}/notes`)
        .send({ text: 'Please quote a non-catalog sander too.' });
    assert.equal(res.status, 201);
    assert.equal(res.body.order.notes_log.length, 1);
    assert.equal(res.body.order.notes_log[0].from, 'customer');

    assert.equal(sentEmails.notes.length, 1);
    assert.ok(sentEmails.notes[0].to.includes('markham@chc.example'));
    assert.ok(!sentEmails.notes[0].to.includes('pat@example.invalid'));
});

test('a customer cannot add a note to another company\'s order', async () => {
    reset();
    authCompany = { id: 'zzzzzzzz-0000-4000-8000-000000000099', name: 'Someone Else', slug: 'assured' };
    const res = await request(storeApp())
        .post(`/api/store/assured/orders/${ORDER}/notes`)
        .send({ text: 'nope' });
    assert.equal(res.status, 404);
});

test('notes accumulate rather than replace one another', async () => {
    reset();
    await request(adminApp()).post(`/api/admin/companies/${CO}/orders/${ORDER}/notes`).send({ text: 'first' });
    const res = await request(storeApp()).post(`/api/store/assured/orders/${ORDER}/notes`).send({ text: 'second' });
    assert.equal(res.body.order.notes_log.length, 2);
    assert.equal(res.body.order.notes_log[0].text, 'first');
    assert.equal(res.body.order.notes_log[1].text, 'second');
});
