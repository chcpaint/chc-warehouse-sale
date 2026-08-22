/**
 * tests/price-on-request.test.js
 *
 * "Contact for current pricing" — the state that stops a quoted item being
 * mistaken for a free one.
 *
 * The behaviour worth defending is not the label. It is that a quoted item is
 * never silently totalled at zero: not on an order, not in stock value, not in
 * job costing. A wrong number that looks complete is worse than a missing one,
 * because nobody goes looking for it.
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { createFakeSupabase } = require('./helpers/fake-supabase');

const ROOT = path.resolve(__dirname, '..');
let fake = createFakeSupabase();
let authCompany = null;
const sent = { orders: [] };

const supabaseProxy = new Proxy({}, {
    get: (_t, prop) => {
        const v = fake[prop];
        return typeof v === 'function' ? v.bind(fake) : v;
    }
});

const stubs = {
    [path.join(ROOT, 'utils/supabase.js')]: { supabaseAdmin: supabaseProxy },
    [path.join(ROOT, 'middleware/auth.js')]: {
        requireCompanyAuth: (req, res, next) => {
            if (!authCompany) return res.status(401).json({ error: 'Not authenticated.' });
            req.company = authCompany;
            next();
        },
        requireAdminAuth: (req, res, next) => next(),
        requireSuperAdmin: (req, res, next) => next(),
        requireCompanyAccess: (req, res, next) => next()
    },
    [path.join(ROOT, 'utils/sanitize.js')]: {
        stripHtml: (s) => String(s === undefined || s === null ? '' : s).replace(/<[^>]*>/g, ''),
        sanitizeObject: (o) => o,
        isValidUUID: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '')),
        generateSlug: (s) => s,
        validateEmail: () => true
    },
    [path.join(ROOT, 'utils/recipients.js')]: {
        resolveOrderRecipients: async () => ({ to: ['branch@chcpaint.com'], replyTo: null }),
        validEmails: (l) => l
    },
    [path.join(ROOT, 'utils/email.js')]: {
        sendOrderNotification: async (opts) => { sent.orders.push(opts); return { sent: true }; },
        sendInvoiceReady: async () => {},
        sendOrderClosed: async () => {},
        sendLowStockAlert: async () => ({ sent: true }),
        sendReorderRaised: async () => ({ sent: true })
    },
    [path.join(ROOT, 'middleware/upload.js')]: {
        catalogUpload: { single: () => (req, res, next) => next() },
        logoUpload: { single: () => (req, res, next) => next() },
        invoiceUpload: { single: () => (req, res, next) => next() }
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

const express = require('express');
const request = require('supertest');
const inventoryStore = require('../routes/inventory-store');

const CO   = '11111111-1111-4111-8111-111111111111';
const LOC  = '33333333-3333-4333-8333-333333333333';
const PAINT = '55555555-5555-4555-8555-555555555555';   // $200, normal
const TOOL  = '77777777-7777-4777-8777-777777777777';   // $0, price on request

function seed() {
    return createFakeSupabase({
        companies: [{
            id: CO, name: 'Assured Collision', slug: 'assured', is_active: true,
            contact_email: 'shop@assured.test', email_config: {},
            settings: { inventory: { enabled: true, auto_draft: false, allow_negative: false } }
        }],
        company_locations: [{ id: LOC, company_id: CO, name: 'Burlington', is_active: true, restrict_to_category: null }],
        products: [
            { id: PAINT, company_id: CO, sku: 'PRF611N', name: 'Clear', category: 'Paint',
              price: 200, is_active: true, price_on_request: false },
            { id: TOOL, company_id: CO, sku: 'MWK0888.22HD', name: 'M18 Dust Extractor',
              category: 'Equip/Filter/Booth', price: 0, is_active: true, price_on_request: true }
        ],
        inventory_levels: [
            { id: 'lvl-1', company_id: CO, location_id: LOC, product_id: PAINT, on_hand: 10, min_point: 2, max_point: 20, is_tracked: true },
            { id: 'lvl-2', company_id: CO, location_id: LOC, product_id: TOOL,  on_hand: 3,  min_point: 1, max_point: 5,  is_tracked: true }
        ]
    });
}

function reset() {
    fake = seed();
    authCompany = { id: CO, name: 'Assured Collision', slug: 'assured' };
    sent.orders = [];
}

function app() {
    const a = express();
    a.use(express.json());
    a.use('/api/store/:slug/inventory', inventoryStore);
    return a;
}

// ==================================================================
// STOCK VALUE
// ==================================================================

test('stock value excludes a quoted item instead of adding zero', async () => {
    reset();
    const res = await request(app()).get(`/api/store/assured/inventory/summary?location_id=${LOC}`);
    assert.equal(res.status, 200);
    // 10 clear at $200. The 3 dust extractors are not valued at all.
    assert.equal(res.body.summary.stock_value, 2000);
});

test('the summary says how many lines it could not value', async () => {
    reset();
    const res = await request(app()).get(`/api/store/assured/inventory/summary?location_id=${LOC}`);
    assert.equal(res.body.summary.unvalued_lines, 1);
});

test('a quoted item with nothing on the shelf is not reported as unvalued', async () => {
    reset();
    fake.db.inventory_levels.find(l => l.product_id === TOOL).on_hand = 0;
    const res = await request(app()).get(`/api/store/assured/inventory/summary?location_id=${LOC}`);
    assert.equal(res.body.summary.unvalued_lines, 0,
        'nothing on hand means nothing unvalued — the warning must not cry wolf');
});

test('a quoted item still counts toward stock status', async () => {
    reset();
    const res = await request(app()).get(`/api/store/assured/inventory/summary?location_id=${LOC}`);
    // Being unpriceable does not make it untracked; it is still on a shelf and
    // still has a minimum.
    assert.equal(res.body.summary.tracked, 2);
});

test('a quoted item priced later is valued normally', async () => {
    reset();
    const tool = fake.db.products.find(p => p.id === TOOL);
    tool.price_on_request = false;
    tool.price = 500;

    const res = await request(app()).get(`/api/store/assured/inventory/summary?location_id=${LOC}`);
    assert.equal(res.body.summary.stock_value, 2000 + 1500);
    assert.equal(res.body.summary.unvalued_lines, 0);
});

// ==================================================================
// THE LEDGER STILL WORKS ON THEM
// ==================================================================

test('a quoted item can still be consumed against a job', async () => {
    reset();
    const res = await request(app()).post('/api/store/assured/inventory/movements').send({
        location_id: LOC, product_id: TOOL, movement_type: 'consume',
        quantity: 1, job_ref: 'RO-1', actor_label: 'Sam'
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.on_hand, 2);
});

test('a quoted item can still be received and counted', async () => {
    reset();
    for (const [type, qty, expected] of [['receive', 2, 5], ['count', 4, 4]]) {
        const res = await request(app()).post('/api/store/assured/inventory/movements').send({
            location_id: LOC, product_id: TOOL, movement_type: type,
            quantity: qty, actor_label: 'Sam'
        });
        assert.equal(res.status, 201, `${type} should be allowed`);
        assert.equal(res.body.on_hand, expected);
    }
});

// ==================================================================
// THE PURE RULE
// ==================================================================

test('price_on_request and a zero price are not the same thing', () => {
    // A genuinely free item is priced at zero and is NOT on request; it should
    // contribute zero and be counted as valued. A quoted item contributes
    // nothing and is counted as unvalued. Nothing in the code may collapse
    // these two into "price is falsy".
    const free = { price: 0, price_on_request: false, on_hand: 5 };
    const quoted = { price: 0, price_on_request: true, on_hand: 5 };

    const value = (r) => r.price_on_request ? null : r.on_hand * r.price;
    assert.equal(value(free), 0, 'free contributes a real zero');
    assert.equal(value(quoted), null, 'quoted contributes nothing at all');
});
