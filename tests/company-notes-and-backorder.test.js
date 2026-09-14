/**
 * tests/company-notes-and-backorder.test.js
 *
 * Two features requested together (see routes/contact-notes-admin.js and the
 * `backorder_items` block in routes/admin.js's status endpoint):
 *
 *   1. company_notes — a general, non-order message thread between a company
 *      and CHC ("we're closing early", "quote this part not in the
 *      catalogue"), reachable by any CHC staff who can already reach that
 *      company's orders (companyInScope / requireCompanyNotesAccess), plus a
 *      cross-company inbox for CHC staff and a customer-facing thread on the
 *      storefront.
 *   2. `backorder_items` on an order — WHICH line(s) are short on a partial
 *      shipment and by how much, checked against the order's own items so
 *      the console can never save a backorder for something that wasn't
 *      ordered or for more than was ordered. The point is that this matches
 *      what's written on the branch's AccountEdge invoice.
 *
 * Harness copied from tests/order-workflow-upgrades.test.js: middleware/auth.js
 * runs for real except for its two JWT-verifying entry points, so
 * restrictOrderDesk / requireOrderAccess / requireCompanyNotesAccess /
 * companyInScope — the actual access-control logic both features depend on
 * — run unmodified.
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

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

const sentEmails = { status: [], notes: [], notifications: [], contact: [] };

// utils/order-scope.js is deliberately NOT stubbed (companyInScope and
// orderInScope are what's under test here too), so it must resolve
// utils/supabase to the fake before middleware/auth.js is ever required.
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
        sendContactNote: async (o) => { sentEmails.contact.push(o); return { sent: true }; },
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
const CO_OTHER = '11111111-1111-4111-8111-111111111199';
const BRANCH_MARKHAM = 'd0000000-0000-4000-8000-000000000001';
const BRANCH_OTHER = 'd0000000-0000-4000-8000-000000000002';
const LOC = '33333333-3333-4333-8333-333333333333';
const PRODUCT = '55555555-5555-4555-8555-555555555555';
const PRODUCT2 = '55555555-5555-4555-8555-555555555556';
const ORDER = 'e0000000-0000-4000-8000-000000000001';

const SUPER_ADMIN = { id: 'a1111111-1111-4111-8111-111111111111', role: 'super_admin', name: 'Sam Super', email: 'sam@chc.example', company_id: null, branch_id: null };
const ORDER_DESK_MARKHAM = { id: 'a2222222-2222-4222-8222-222222222222', role: 'order_desk', name: 'Dana Desk', email: 'dana@chc.example', company_id: null, branch_id: BRANCH_MARKHAM };
const ORDER_DESK_OTHER = { id: 'a3333333-3333-4333-8333-333333333333', role: 'order_desk', name: 'Otto Other', email: 'otto@chc.example', company_id: null, branch_id: BRANCH_OTHER };
const ORDER_MANAGER = { id: 'a4444444-4444-4444-8444-444444444444', role: 'order_manager', name: 'Mo Manager', email: 'mo@chc.example', company_id: null, branch_id: null };
const COMPANY_ADMIN = { id: 'a5555555-5555-4555-8555-555555555555', role: 'company_admin', name: 'Cara Company', email: 'cara@chc.example', company_id: CO, branch_id: null };

function baseOrder(overrides = {}) {
    return {
        id: ORDER, company_id: CO, order_number: 'CHC-1001',
        contact_name: 'Pat Painter', contact_email: 'pat@example.invalid', contact_phone: '555-0100',
        company_name: 'Assured Collision', location: 'Main', location_id: LOC,
        items: [
            { product_id: PRODUCT, name: 'Widget', sku: 'W-1', quantity: 5, unit_price: 25, subtotal: 125, price_on_request: false },
            { product_id: PRODUCT2, name: 'Sprocket', sku: 'S-2', quantity: 3, unit_price: 10, subtotal: 30, price_on_request: false }
        ],
        subtotal: 155, tax: 20.15, tax_rate: 0.13, delivery_fee: 10, total: 185.15,
        notes: '', status: 'pending', status_history: [], is_partial_shipment: false, notes_log: [],
        backorder_items: [],
        ...overrides
    };
}

function reset(opts = {}) {
    fake = createFakeSupabase({
        distributors: [
            { id: CHC_ID, name: 'CHC Paint & Auto Body Supplies', slug: 'chc', custom_domain: null, is_active: true, is_default: true, settings: opts.distributorSettings ?? { order_status_mode: 'simplified' } }
        ],
        companies: [
            { id: CO, distributor_id: CHC_ID, name: 'Assured Collision', slug: 'assured', is_active: true, contact_email: 'shop@example.invalid', email_config: {}, settings: opts.companySettings || {} },
            { id: CO_OTHER, distributor_id: CHC_ID, name: 'Bayview Auto Body', slug: 'bayview', is_active: true, contact_email: 'bayview@example.invalid', email_config: {}, settings: {} }
        ],
        company_locations: [
            { id: LOC, company_id: CO, name: 'Main', is_active: true, supplier_branch_id: BRANCH_MARKHAM, notify_emails: [], restrict_to_category: null }
        ],
        supplier_branches: [
            { id: BRANCH_MARKHAM, name: 'Markham', emails: ['markham@chc.example'], is_active: true },
            { id: BRANCH_OTHER, name: 'Other Branch', emails: ['other@chc.example'], is_active: true }
        ],
        products: [
            { id: PRODUCT, company_id: CO, sku: 'W-1', name: 'Widget', price: 25, is_active: true, price_on_request: false },
            { id: PRODUCT2, company_id: CO, sku: 'S-2', name: 'Sprocket', price: 10, is_active: true, price_on_request: false }
        ],
        orders: [baseOrder(opts.orderOverrides)],
        company_notes: opts.companyNotes || [],
        audit_log: []
    });
    authAdmin = SUPER_ADMIN;
    authCompany = { id: CO, name: 'Assured Collision', slug: 'assured' };
    authCompanyUser = null;
    sentEmails.status = []; sentEmails.notes = []; sentEmails.notifications = []; sentEmails.contact = [];
}

function adminApp() {
    const a = express();
    a.use(express.json());
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
// 1. company_notes — admin side (routes/contact-notes-admin.js)
// ==================================================================

test('super admin reads a company\'s thread and unread customer notes get marked read', async () => {
    reset({
        companyNotes: [
            { id: 'n1', company_id: CO, location_id: null, author_type: 'customer', author_name: 'Pat Painter', author_email: 'pat@example.invalid', text: 'Closing early Friday', read_at: null, created_at: '2026-01-01T00:00:00Z' },
            { id: 'n2', company_id: CO, location_id: null, author_type: 'staff', author_name: 'Dana Desk', author_email: 'dana@chc.example', text: 'Noted, thanks', read_at: '2026-01-02T00:00:00Z', created_at: '2026-01-02T00:00:00Z' }
        ]
    });
    const res = await request(adminApp()).get(`/api/admin/companies/${CO}/notes`);
    assert.equal(res.status, 200);
    assert.equal(res.body.company.name, 'Assured Collision');
    assert.equal(res.body.notes.length, 2);
    const unread = res.body.notes.find(n => n.id === 'n1');
    assert.ok(unread.read_at, 'opening the thread must mark the unread customer note read');
    assert.equal(fake.db.company_notes.find(n => n.id === 'n1').read_by, SUPER_ADMIN.id);
});

test('GET for a company that does not exist is a 404', async () => {
    reset();
    const res = await request(adminApp()).get(`/api/admin/companies/00000000-0000-4000-8000-000000000000/notes`);
    assert.equal(res.status, 404);
});

test('an order-desk account whose branch serves the company can read and reply', async () => {
    reset();
    authAdmin = ORDER_DESK_MARKHAM;
    const res = await request(adminApp())
        .post(`/api/admin/companies/${CO}/notes`)
        .send({ text: 'We can quote that part, one sec.' });
    assert.equal(res.status, 201);
    assert.equal(res.body.note.author_type, 'staff');
    assert.equal(res.body.note.author_name, 'Dana Desk');
});

test('an order-desk account whose branch does NOT serve the company is refused (companyInScope)', async () => {
    reset();
    authAdmin = ORDER_DESK_OTHER;
    const res = await request(adminApp()).get(`/api/admin/companies/${CO}/notes`);
    assert.equal(res.status, 403);
});

test('an order_manager can reach any company\'s thread', async () => {
    reset();
    authAdmin = ORDER_MANAGER;
    const res = await request(adminApp()).get(`/api/admin/companies/${CO}/notes`);
    assert.equal(res.status, 200);
});

test('a company-scoped admin can reach their own company\'s thread but not another\'s', async () => {
    reset();
    authAdmin = COMPANY_ADMIN;
    const own = await request(adminApp()).get(`/api/admin/companies/${CO}/notes`);
    assert.equal(own.status, 200);
    const other = await request(adminApp()).get(`/api/admin/companies/${CO_OTHER}/notes`);
    assert.equal(other.status, 403);
});

test('a staff reply is pre-marked read and emails the customer side, not the branch that wrote it', async () => {
    reset();
    authAdmin = ORDER_DESK_MARKHAM;
    const res = await request(adminApp())
        .post(`/api/admin/companies/${CO}/notes`)
        .send({ text: 'Yes, closing early is fine, thanks for the heads up.' });
    assert.equal(res.status, 201);
    assert.ok(res.body.note.read_at, 'a staff-authored note is already read');

    assert.equal(sentEmails.contact.length, 1);
    assert.ok(sentEmails.contact[0].fromStaff);
    assert.ok(sentEmails.contact[0].to.includes('shop@example.invalid'),
        'a company-wide note has no single order to resolve an orderer from -- it reaches the company\'s own contact address');
    assert.ok(!sentEmails.contact[0].to.includes('markham@chc.example'),
        'a staff reply must reach the customer side, not go back to CHC');
});

test('a blank or oversized message is refused', async () => {
    reset();
    const blank = await request(adminApp()).post(`/api/admin/companies/${CO}/notes`).send({ text: '   ' });
    assert.equal(blank.status, 400);
    const huge = await request(adminApp()).post(`/api/admin/companies/${CO}/notes`).send({ text: 'x'.repeat(4001) });
    assert.equal(huge.status, 400);
});

// ==================================================================
// 2. company_notes — cross-company inbox (GET /notes/inbox)
// ==================================================================

test('super admin\'s inbox lists every company\'s notes with an unread count', async () => {
    reset({
        companyNotes: [
            { id: 'n1', company_id: CO, location_id: null, author_type: 'customer', author_name: 'Pat Painter', text: 'msg 1', read_at: null, created_at: '2026-01-01T00:00:00Z' },
            { id: 'n2', company_id: CO_OTHER, location_id: null, author_type: 'customer', author_name: 'Bay View', text: 'msg 2', read_at: null, created_at: '2026-01-02T00:00:00Z' }
        ]
    });
    const res = await request(adminApp()).get('/api/admin/notes/inbox');
    assert.equal(res.status, 200);
    assert.equal(res.body.notes.length, 2);
    assert.equal(res.body.unread_count, 2);
    const row = res.body.notes.find(n => n.company_id === CO);
    assert.equal(row.company_name, 'Assured Collision', 'the companies(name) embed must be resolved');
});

test('an order-desk account\'s inbox is scoped to companies its branch actually serves', async () => {
    reset({
        companyNotes: [
            { id: 'n1', company_id: CO, location_id: null, author_type: 'customer', author_name: 'Pat', text: 'msg 1', read_at: null, created_at: '2026-01-01T00:00:00Z' },
            { id: 'n2', company_id: CO_OTHER, location_id: null, author_type: 'customer', author_name: 'Bay', text: 'msg 2', read_at: null, created_at: '2026-01-02T00:00:00Z' }
        ]
    });
    authAdmin = ORDER_DESK_MARKHAM;
    const res = await request(adminApp()).get('/api/admin/notes/inbox');
    assert.equal(res.status, 200);
    assert.equal(res.body.notes.length, 1);
    assert.equal(res.body.notes[0].company_id, CO);

    authAdmin = ORDER_DESK_OTHER;
    const none = await request(adminApp()).get('/api/admin/notes/inbox');
    assert.equal(none.status, 200);
    assert.deepEqual(none.body.notes, []);
    assert.equal(none.body.unread_count, 0);
});

test('a company-scoped admin\'s inbox only ever shows their own company', async () => {
    reset({
        companyNotes: [
            { id: 'n1', company_id: CO, location_id: null, author_type: 'customer', author_name: 'Pat', text: 'msg 1', read_at: null, created_at: '2026-01-01T00:00:00Z' },
            { id: 'n2', company_id: CO_OTHER, location_id: null, author_type: 'customer', author_name: 'Bay', text: 'msg 2', read_at: null, created_at: '2026-01-02T00:00:00Z' }
        ]
    });
    authAdmin = COMPANY_ADMIN;
    const res = await request(adminApp()).get('/api/admin/notes/inbox');
    assert.equal(res.status, 200);
    assert.equal(res.body.notes.length, 1);
    assert.equal(res.body.notes[0].company_id, CO);
});

// ==================================================================
// 3. company_notes — storefront side (routes/storefront.js)
// ==================================================================

test('a customer reads their own company\'s thread', async () => {
    reset({
        companyNotes: [
            { id: 'n1', company_id: CO, location_id: null, author_type: 'staff', author_name: 'Dana Desk', text: 'On it', read_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' },
            { id: 'n2', company_id: CO_OTHER, location_id: null, author_type: 'staff', author_name: 'Dana Desk', text: 'not theirs', read_at: null, created_at: '2026-01-01T00:00:00Z' }
        ]
    });
    const res = await request(storeApp()).get('/api/store/assured/contact-notes');
    assert.equal(res.status, 200);
    assert.equal(res.body.notes.length, 1);
    assert.equal(res.body.notes[0].id, 'n1');
});

test('a customer sends a message; it saves and emails the servicing branch', async () => {
    reset();
    authCompanyUser = { name: 'Pat Painter', email: 'pat@example.invalid' };
    const res = await request(storeApp())
        .post('/api/store/assured/contact-notes')
        .send({ text: 'Do you carry 3M 06652 tape? Not showing in the catalogue.', location_id: LOC });
    assert.equal(res.status, 201);
    assert.equal(res.body.note.author_type, 'customer');
    assert.equal(res.body.note.author_name, 'Pat Painter');
    assert.equal(fake.db.company_notes.length, 1);
    assert.equal(fake.db.company_notes[0].location_id, LOC);

    assert.equal(sentEmails.contact.length, 1);
    assert.ok(!sentEmails.contact[0].fromStaff);
    assert.ok(sentEmails.contact[0].to.includes('markham@chc.example'));
});

test('a blank or oversized customer message is refused', async () => {
    reset();
    const blank = await request(storeApp()).post('/api/store/assured/contact-notes').send({ text: '' });
    assert.equal(blank.status, 400);
    const huge = await request(storeApp()).post('/api/store/assured/contact-notes').send({ text: 'y'.repeat(4001) });
    assert.equal(huge.status, 400);
});

test('a location_id that does not belong to this company is refused', async () => {
    reset();
    const res = await request(storeApp())
        .post('/api/store/assured/contact-notes')
        .send({ text: 'trying a foreign location', location_id: '99999999-0000-4000-8000-000000000000' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /not on this account/);
});

test('a message with no location still saves and still reaches CHC (no branch email attempted)', async () => {
    reset();
    const res = await request(storeApp())
        .post('/api/store/assured/contact-notes')
        .send({ text: 'General question, not tied to a location.' });
    assert.equal(res.status, 201);
    assert.equal(fake.db.company_notes[0].location_id, null);
    assert.equal(sentEmails.contact.length, 0, 'no servicing branch to resolve without a location');
});

// ==================================================================
// 4. backorder_items on PUT /orders/:orderId/status
// ==================================================================

test('backorder items are matched to the order\'s own lines by product_id and stored with the status update', async () => {
    reset();
    const res = await request(adminApp())
        .put(`/api/admin/orders/${ORDER}/status`)
        .send({
            status: 'out_on_delivery', is_partial_shipment: true,
            backorder_items: [{ product_id: PRODUCT, quantity: 2 }]
        });
    assert.equal(res.status, 200);
    assert.equal(res.body.order.is_partial_shipment, true);
    assert.deepEqual(res.body.order.backorder_items, [{ product_id: PRODUCT, sku: 'W-1', name: 'Widget', quantity: 2 }]);

    assert.equal(sentEmails.status.length, 1);
    assert.equal(sentEmails.status[0].isPartialShipment, true);
    assert.deepEqual(sentEmails.status[0].backorderItems, [{ product_id: PRODUCT, sku: 'W-1', name: 'Widget', quantity: 2 }]);
});

test('an item can also be matched by sku, or by name alone, when no product_id is sent', async () => {
    reset();
    const bySku = await request(adminApp())
        .put(`/api/admin/orders/${ORDER}/status`)
        .send({ status: 'out_on_delivery', is_partial_shipment: true, backorder_items: [{ sku: 'S-2', quantity: 1 }] });
    assert.equal(bySku.status, 200);
    assert.equal(bySku.body.order.backorder_items[0].name, 'Sprocket');

    const byName = await request(adminApp())
        .put(`/api/admin/orders/${ORDER}/status`)
        .send({ status: 'out_on_delivery', is_partial_shipment: true, backorder_items: [{ name: 'Widget', quantity: 1 }] });
    assert.equal(byName.status, 200);
    assert.equal(byName.body.order.backorder_items[0].product_id, PRODUCT);
});

test('multiple backordered lines can be saved together', async () => {
    reset();
    const res = await request(adminApp())
        .put(`/api/admin/orders/${ORDER}/status`)
        .send({
            status: 'out_on_delivery', is_partial_shipment: true,
            backorder_items: [{ product_id: PRODUCT, quantity: 2 }, { product_id: PRODUCT2, quantity: 1 }]
        });
    assert.equal(res.status, 200);
    assert.equal(res.body.order.backorder_items.length, 2);
});

test('an item that is not on the order is refused, matching by name in the error', async () => {
    reset();
    const res = await request(adminApp())
        .put(`/api/admin/orders/${ORDER}/status`)
        .send({ status: 'out_on_delivery', is_partial_shipment: true, backorder_items: [{ name: 'Not On This Order', quantity: 1 }] });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /not on this order/);
});

test('a backordered quantity greater than what was ordered is refused', async () => {
    reset();
    const res = await request(adminApp())
        .put(`/api/admin/orders/${ORDER}/status`)
        .send({ status: 'out_on_delivery', is_partial_shipment: true, backorder_items: [{ product_id: PRODUCT, quantity: 99 }] });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /can't exceed the 5 ordered/);
});

test('a zero, negative, or non-integer quantity is refused', async () => {
    reset();
    for (const qty of [0, -1, 1.5, 'two']) {
        const res = await request(adminApp())
            .put(`/api/admin/orders/${ORDER}/status`)
            .send({ status: 'out_on_delivery', is_partial_shipment: true, backorder_items: [{ product_id: PRODUCT, quantity: qty }] });
        assert.equal(res.status, 400, `quantity ${JSON.stringify(qty)} should be refused`);
    }
});

test('backorder_items sent without is_partial_shipment are silently dropped, same as the flag itself', async () => {
    reset();
    const res = await request(adminApp())
        .put(`/api/admin/orders/${ORDER}/status`)
        .send({ status: 'out_on_delivery', backorder_items: [{ product_id: PRODUCT, quantity: 2 }] });
    assert.equal(res.status, 200);
    assert.equal(res.body.order.is_partial_shipment, false);
    assert.deepEqual(res.body.order.backorder_items, []);
});

test('closing a previously-partial order clears its backorder items', async () => {
    reset({ orderOverrides: { status: 'out_on_delivery', is_partial_shipment: true, backorder_items: [{ product_id: PRODUCT, sku: 'W-1', name: 'Widget', quantity: 2 }] } });
    const res = await request(adminApp())
        .put(`/api/admin/orders/${ORDER}/status`)
        .send({ status: 'closed' });
    assert.equal(res.status, 200);
    assert.equal(res.body.order.is_partial_shipment, false);
    assert.deepEqual(res.body.order.backorder_items, []);
});

test('GET /orders carries backorder_items through to the console', async () => {
    reset({ orderOverrides: { status: 'out_on_delivery', is_partial_shipment: true, backorder_items: [{ product_id: PRODUCT, sku: 'W-1', name: 'Widget', quantity: 2 }] } });
    const list = await request(adminApp()).get('/api/admin/orders');
    assert.deepEqual(list.body.orders[0].backorder_items, [{ product_id: PRODUCT, sku: 'W-1', name: 'Widget', quantity: 2 }]);
});

test('the storefront order list exposes backorder_items so the customer\'s view can match the invoice', async () => {
    reset({ orderOverrides: { status: 'out_on_delivery', is_partial_shipment: true, backorder_items: [{ product_id: PRODUCT, sku: 'W-1', name: 'Widget', quantity: 2 }] } });
    const res = await request(storeApp()).get('/api/store/assured/orders');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.orders[0].backorder_items, [{ product_id: PRODUCT, sku: 'W-1', name: 'Widget', quantity: 2 }]);
});

test('an order-desk account outside the order\'s branch still cannot touch its status (unchanged scoping)', async () => {
    reset();
    authAdmin = ORDER_DESK_OTHER;
    const res = await request(adminApp())
        .put(`/api/admin/orders/${ORDER}/status`)
        .send({ status: 'out_on_delivery', is_partial_shipment: true, backorder_items: [{ product_id: PRODUCT, quantity: 1 }] });
    assert.equal(res.status, 403);
});
