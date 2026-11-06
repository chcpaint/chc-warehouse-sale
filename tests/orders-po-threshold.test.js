/**
 * tests/orders-po-threshold.test.js
 *
 * "No PO needed under $X before tax" (settings.purchase_orders.optional_below).
 * Built for Assured: an order under $500.00 before tax needs no PO; at $500.00
 * and above the PO is required exactly as before. Through the real order route.
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
        requireCompanyAccess: (req, res, next) => next(),
        // Added when per-company customer users landed. The storefront now pulls
        // in company-users-store, which calls router.use() with these at module
        // load — so a stub missing one of them is not a failing assertion, it is
        // the whole file refusing to load.
        requireCompanyUser: (req, res, next) => next(),
        requireCompanyOwner: (req, res, next) => next(),
        requireFullAdmin: (req, res, next) => next(),
        restrictOrderDesk: (req, res, next) => next(),
        requireOrderAccess: (req, res, next) => next()
    },
    [path.join(ROOT, 'utils/sanitize.js')]: {
        stripHtml: (s) => String(s === undefined || s === null ? '' : s).replace(/<[^>]*>/g, ''),
        sanitizeObject: (o) => o,
        isValidUUID: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '')),
        generateSlug: (s) => s,
        validateEmail: () => true
    },
    [path.join(ROOT, 'utils/recipients.js')]: {
        resolveOrderRecipients: async () => ({ to: ['branch@example.invalid'], replyTo: null }),
        validEmails: (l) => l
    },
    [path.join(ROOT, 'utils/email.js')]: {
        sendOrderNotification: async (o) => { sent.orders.push(o); return { sent: true }; },
        sendInvoiceReady: async () => {}, sendOrderClosed: async () => {},
        sendLowStockAlert: async () => ({ sent: true }), sendReorderRaised: async () => ({ sent: true })
    },
    [path.join(ROOT, 'utils/payments.js')]: {
        paymentsEnabled: () => false,
        publicPaymentConfig: () => ({ enabled: false }),
        getStripe: () => null
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
const storefront = require('../routes/storefront');


const CO = '11111111-1111-4111-8111-111111111111';
const LOC = '33333333-3333-4333-8333-333333333333';
const P100 = '55555555-5555-4555-8555-555555555501';   // $100.00
const P99 = '55555555-5555-4555-8555-555555555502';    // $99.99
const PQ = '55555555-5555-4555-8555-555555555503';     // price on request
const PROMO = '55555555-5555-4555-8555-555555555504';  // list $200, promo $50

function reset(poBlock, extra = {}) {
    fake = createFakeSupabase({
        companies: [{ id: CO, name: 'Assured', slug: 'test', is_active: true, contact_email: 'shop@example.invalid',
            email_config: {}, settings: poBlock === null ? {} : { purchase_orders: poBlock } }],
        company_locations: [{ id: LOC, company_id: CO, name: 'Main', is_active: true, restrict_to_category: null }],
        products: [
            { id: P100, company_id: CO, sku: 'A-100', name: 'Hundred', category: 'Misc', price: 100, is_active: true, price_on_request: false },
            { id: P99, company_id: CO, sku: 'A-99', name: 'Ninety nine', category: 'Misc', price: 99.99, is_active: true, price_on_request: false },
            { id: PQ, company_id: CO, sku: 'A-Q', name: 'Call', category: 'Misc', price: 0, is_active: true, price_on_request: true },
            { id: PROMO, company_id: CO, sku: 'A-P', name: 'Promo', category: 'Misc', price: 200, is_active: true, price_on_request: false }
        ],
        company_po_sequences: [],
        ...extra
    });
    authCompany = { id: CO, name: 'Assured', slug: 'test' };
    sent.orders = [];
}
function app() { const a = express(); a.use(express.json()); a.use('/api/store', storefront); return a; }
const order = (items, po) => ({
    contact_name: 'Sam', contact_email: 'sam@example.invalid', contact_phone: '000',
    location_id: LOC, location: 'Main', items,
    ...(po === undefined ? {} : { po_number: po })
});
const post = (items, po) => request(app()).post('/api/store/test/orders').send(order(items, po));
const A = { mode: 'manual', optional_below: 500 };

test('under $500 before tax: no PO needed, and the order is stored without one', async () => {
    reset(A);
    const res = await post([{ product_id: P100, quantity: 4 }]);        // $400.00
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(fake.db.orders[0].po_number, null);
    assert.equal(fake.db.orders[0].po_source, 'none');
});

test('one cent under the line is still under: $499.95 needs no PO', async () => {
    reset(A);
    const res = await post([{ product_id: P99, quantity: 5 }]);          // 499.95
    assert.equal(res.status, 201, JSON.stringify(res.body));
});

test('exactly $500.00 is NOT under: a PO is required', async () => {
    reset(A);
    const res = await post([{ product_id: P100, quantity: 5 }]);        // 500.00
    assert.equal(res.status, 400);
    assert.match(res.body.error, /purchase order number is required for orders of \$500\.00 or more before tax/i);
    assert.equal(res.body.po_required, true);
    assert.equal(fake.db.orders.length, 0);
});

test('over $500: a PO is required, and with one the order goes through as it always did', async () => {
    reset(A);
    assert.equal((await post([{ product_id: P100, quantity: 6 }], '')).status, 400);
    const ok = await post([{ product_id: P100, quantity: 6 }], ' po-9 ');
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(fake.db.orders[0].po_number, 'PO-9');
    assert.equal(fake.db.orders[0].po_source, 'manual');
});

test('a PO typed on a small order is still stored', async () => {
    reset(A);
    const res = await post([{ product_id: P100, quantity: 1 }], 'abc-1');
    assert.equal(res.status, 201);
    assert.equal(fake.db.orders[0].po_number, 'ABC-1');
});

test('the amount compared is before tax: $499.96 (over $560 with 13% tax) needs no PO', async () => {
    reset(A);
    const res = await post([{ product_id: P99, quantity: 4 }, { product_id: P100, quantity: 1 }]);   // 399.96 + 100 = 499.96
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(Number(fake.db.orders[0].total) > 500, 'the total with tax is over $500 and that must not matter');
});

test('an order with a price-on-request line still needs a PO: its real value is unknown', async () => {
    reset(A);
    const res = await post([{ product_id: P100, quantity: 1 }, { product_id: PQ, quantity: 1 }]);
    assert.equal(res.status, 400);
    assert.equal(res.body.po_required, true);
});

test('with no threshold set, every order needs a PO exactly as before', async () => {
    reset({ mode: 'manual' });
    const res = await post([{ product_id: P100, quantity: 1 }]);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'A purchase order number is required.');
    assert.equal(res.body.po_required, undefined);
});

test('a company with no PO settings at all is unchanged: PO required', async () => {
    reset(null);
    assert.equal((await post([{ product_id: P100, quantity: 1 }])).status, 400);
});

test('a junk threshold (0, negative, text) switches the feature off', async () => {
    for (const bad of [0, -5, 'abc', null, true, '']) {
        reset({ mode: 'manual', optional_below: bad });
        assert.equal((await post([{ product_id: P100, quantity: 1 }])).status, 400, `optional_below=${bad}`);
    }
});

test('the threshold does nothing for companies that do not use manual POs', async () => {
    reset({ mode: 'off', optional_below: 500 });
    assert.equal((await post([{ product_id: P100, quantity: 1 }])).status, 201);
    assert.equal(fake.db.orders[0].po_number, null);
    reset({ mode: 'generated', optional_below: 500 });
    const res = await post([{ product_id: P100, quantity: 1 }]);
    assert.equal(res.status, 409, 'generated still allocates from its own sequence');
});

test('the server uses its own prices: an active promotion that brings the order under $500 counts', async () => {
    const promo = { id: 'pr1', product_id: PROMO, promo_price: 50, is_active: true, company_id: CO,
        starts_at: '2000-01-01T00:00:00Z', ends_at: '2999-01-01T00:00:00Z' };
    reset(A, { promotions: [promo] });
    const res = await post([{ product_id: PROMO, quantity: 8 }]);      // $400 with the promo ($1,600 at list)
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(Number(fake.db.orders[0].subtotal), 400);
    reset(A);                                                           // no promotion: $1,600 at list
    assert.equal((await post([{ product_id: PROMO, quantity: 8 }])).status, 400);
});

test('the PO config endpoint tells the cart the threshold', async () => {
    reset(A);
    const res = await request(app()).get('/api/store/test/po/config');
    assert.equal(res.status, 200);
    assert.equal(res.body.mode, 'manual');
    assert.equal(res.body.optional_below, 500);
    reset({ mode: 'manual' });
    assert.equal((await request(app()).get('/api/store/test/po/config')).body.optional_below, null);
});

test('the cart carries a standing notice that purchases under the limit need no PO', () => {
    const html = require('node:fs').readFileSync(path.join(ROOT, 'public/store.html'), 'utf8');
    assert.match(html, /id="cart-po-threshold-note"/);
    assert.match(html, /'Purchases under ' \+ poMoney\(poConfig\.optional_below\) \+ ' before tax do not require a PO'/);
    // shown only for a manual-PO company that has a threshold
    assert.match(html, /poConfig\.mode === 'manual' && Number\(poConfig\.optional_below\) > 0/);
});
