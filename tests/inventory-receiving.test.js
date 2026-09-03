/**
 * tests/inventory-receiving.test.js
 *
 * Receiving tied to a specific CHC order: listing what's receivable, one
 * order's lines against what has actually shown up, and posting a batch of
 * scans against it. The cases that matter more than the happy path: an
 * order nobody can receive against yet (still pending), one that's done
 * (cancelled/closed), a box that has more in it than the packing slip said
 * (unexpected_item), and a line that overshoots what was ordered.
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { createFakeSupabase } = require('./helpers/fake-supabase');

// ------------------------------------------------------------------
// Stubs, installed before the routes are required.
// ------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '..');
let fake = createFakeSupabase();
let authCompany = null;

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
        resolveOrderRecipients: async () => ({ to: ['branch@chcpaint.com'], replyTo: 'shop@example.com' }),
        validEmails: (list) => list
    },
    [path.join(ROOT, 'utils/email.js')]: {
        sendOrderNotification: async () => {},
        sendInvoiceReady: async () => {},
        sendOrderClosed: async () => {},
        sendLowStockAlert: async () => ({ ok: true })
    },
    [path.join(ROOT, 'utils/inventory-alerts.js')]: {
        notifyReorderRaised: async () => {}
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

// ------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------
const CO       = '11111111-1111-4111-8111-111111111111';
const OTHER_CO = '22222222-2222-4222-8222-222222222222';
const LOC      = '33333333-3333-4333-8333-333333333333';

const CLEAR    = '55555555-5555-4555-8555-555555555555';
const TAPE     = '77777777-7777-4777-8777-777777777777';
const FILTER   = '88888888-8888-4888-8888-888888888888';

function seed(opts = {}) {
    const settings = { enabled: true, auto_draft: false, allow_negative: false, ...(opts.settings || {}) };

    return createFakeSupabase({
        companies: [
            { id: CO, name: 'Assured Collision', slug: 'assured', settings: { inventory: settings } },
            { id: OTHER_CO, name: 'Other Shop', slug: 'other', settings: { inventory: { enabled: true } } }
        ],
        company_locations: [
            { id: LOC, company_id: CO, name: 'Burlington', is_active: true, restrict_to_category: null }
        ],
        products: [
            { id: CLEAR,  company_id: CO, sku: 'PRF611N', name: 'ProForm Clear Ga', category: 'Paint', price: 200, is_active: true },
            { id: TAPE,   company_id: CO, sku: 'MMM06334', name: '3M Masking Tape', category: 'Masking', price: 10, is_active: true },
            { id: FILTER, company_id: CO, sku: 'BOOTH-1',  name: 'Booth filter',    category: 'Equip/Filter/Booth', price: 40, is_active: true }
        ],
        inventory_levels: [
            { id: 'lvl-1', company_id: CO, location_id: LOC, product_id: CLEAR, on_hand: 5,  is_tracked: true },
            { id: 'lvl-2', company_id: CO, location_id: LOC, product_id: TAPE,  on_hand: 20, is_tracked: true }
        ],
        ...(opts.extra || {})
    });
}

function reset(opts) {
    fake = seed(opts);
    authCompany = { id: CO, name: 'Assured Collision', slug: 'assured' };
}

function app() {
    const a = express();
    a.use(express.json());
    a.use('/api/store/:slug/inventory', inventoryStore);
    return a;
}

/** Seed an order the way orders.items actually shapes a line — through the fake's own insert path, so the column guard runs too. */
async function seedOrder(overrides = {}) {
    const { data: order } = await fake.from('orders').insert({
        company_id: CO, order_number: 'CHC-1001', company_name: 'Assured Collision',
        contact_name: 'Shop Manager', contact_email: 'shop@example.com',
        location_id: LOC,
        items: [
            { product_id: CLEAR, sku: 'PRF611N', name: 'ProForm Clear Ga', quantity: 4, unit_price: 200 },
            { product_id: TAPE,  sku: 'MMM06334', name: '3M Masking Tape', quantity: 10, unit_price: 10 }
        ],
        subtotal: 900, tax: 117, total: 1017,
        status: 'confirmed',
        ...overrides
    }).select().single();
    return order;
}

const R = '/api/store/assured/inventory/receiving';

// ==================================================================
// LISTING
// ==================================================================

test('a confirmed order appears in the receivable list', async () => {
    reset();
    const order = await seedOrder();
    const res = await request(app()).get(`${R}/orders`);
    assert.equal(res.status, 200);
    assert.equal(res.body.orders.length, 1);
    assert.equal(res.body.orders[0].id, order.id);
    assert.equal(res.body.orders[0].ordered_total, 14);
    assert.equal(res.body.orders[0].received_total, 0);
    assert.equal(res.body.orders[0].fully_received, false);
});

test('a pending order is not receivable yet', async () => {
    reset();
    await seedOrder({ order_number: 'CHC-1002', status: 'pending' });
    const res = await request(app()).get(`${R}/orders`);
    assert.equal(res.body.orders.length, 0);
});

test('cancelled and closed orders are excluded from the list', async () => {
    reset();
    await seedOrder({ order_number: 'CHC-1003', status: 'cancelled' });
    await seedOrder({ order_number: 'CHC-1004', status: 'closed' });
    const res = await request(app()).get(`${R}/orders`);
    assert.equal(res.body.orders.length, 0);
});

test('a location filter narrows the list to orders placed for it', async () => {
    reset();
    const OTHER_LOC = '44444444-4444-4444-8444-444444444444';
    await seedOrder();
    await seedOrder({ order_number: 'CHC-1005', location_id: OTHER_LOC });
    const res = await request(app()).get(`${R}/orders?location_id=${LOC}`);
    assert.equal(res.body.orders.length, 1);
});

test('another company cannot see this company\'s receivable orders', async () => {
    reset();
    await seedOrder();
    authCompany = { id: OTHER_CO, name: 'Other Shop', slug: 'other' };
    const res = await request(app()).get(`${R}/orders`);
    assert.equal(res.body.orders.length, 0);
});

test('a fully received order sorts after ones still open', async () => {
    reset();
    const done = await seedOrder({ order_number: 'CHC-DONE' });
    const open = await seedOrder({ order_number: 'CHC-OPEN' });

    await request(app()).post(`${R}/orders/${done.id}/lines`).send({
        location_id: LOC, actor_label: 'Sam',
        receipts: [{ product_id: CLEAR, quantity: 4 }, { product_id: TAPE, quantity: 10 }]
    });

    const res = await request(app()).get(`${R}/orders`);
    const ids = res.body.orders.map(o => o.id);
    assert.deepEqual(ids, [open.id, done.id]);
});

// ==================================================================
// DETAIL
// ==================================================================

test('order detail lines carry ordered, received and remaining', async () => {
    reset();
    const order = await seedOrder();
    await request(app()).post(`${R}/orders/${order.id}/lines`).send({
        location_id: LOC, actor_label: 'Sam',
        receipts: [{ product_id: CLEAR, quantity: 1 }]
    });

    const res = await request(app()).get(`${R}/orders/${order.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.receivable, true);
    const clearLine = res.body.lines.find(l => l.product_id === CLEAR);
    assert.equal(clearLine.quantity_ordered, 4);
    assert.equal(clearLine.quantity_received, 1);
    assert.equal(clearLine.remaining, 3);
    assert.equal(clearLine.over_received, false);
});

test('an order that does not belong to this company is not found', async () => {
    reset();
    const order = await seedOrder();
    authCompany = { id: OTHER_CO, name: 'Other Shop', slug: 'other' };
    const res = await request(app()).get(`${R}/orders/${order.id}`);
    assert.equal(res.status, 404);
});

// ==================================================================
// RECEIVING A BATCH
// ==================================================================

test('receiving every line in full marks the order fully received', async () => {
    reset();
    const order = await seedOrder();
    const res = await request(app()).post(`${R}/orders/${order.id}/lines`).send({
        location_id: LOC, actor_label: 'Sam',
        receipts: [{ product_id: CLEAR, quantity: 4 }, { product_id: TAPE, quantity: 10 }]
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.applied, 2);
    assert.equal(res.body.failed, 0);

    const detail = await request(app()).get(`${R}/orders/${order.id}`);
    assert.equal(detail.body.order.fully_received, true);
});

test('a receipt writes a real stock movement and moves on-hand', async () => {
    reset();
    const order = await seedOrder();
    await request(app()).post(`${R}/orders/${order.id}/lines`).send({
        location_id: LOC, actor_label: 'Sam',
        receipts: [{ product_id: CLEAR, quantity: 2 }]
    });

    const movement = fake.db.stock_movements.find(m => m.product_id === CLEAR);
    assert.ok(movement, 'a stock_movements row must exist');
    assert.equal(movement.movement_type, 'receive');
    assert.equal(movement.source_doc_type, 'order_receive');
    assert.equal(movement.source_doc_id, order.id);
    assert.equal(Number(movement.qty_change), 2);

    const level = fake.db.inventory_levels.find(l => l.product_id === CLEAR && l.location_id === LOC);
    assert.equal(level.on_hand, 7);
});

test('a receipt writes an order_receipts row linking back to the movement', async () => {
    reset();
    const order = await seedOrder();
    await request(app()).post(`${R}/orders/${order.id}/lines`).send({
        location_id: LOC, actor_label: 'Sam',
        receipts: [{ product_id: CLEAR, quantity: 2, scanned_barcode: '051131020474' }]
    });

    assert.equal(fake.db.order_receipts.length, 1);
    const receipt = fake.db.order_receipts[0];
    assert.equal(receipt.order_id, order.id);
    assert.equal(receipt.product_id, CLEAR);
    assert.equal(Number(receipt.quantity_received), 2);
    assert.equal(receipt.unexpected_item, false);
    assert.ok(receipt.movement_id, 'must link back to the stock_movements row it produced');
    assert.equal(receipt.actor_label, 'Sam');
});

test('a partial receipt reports remaining without marking the order done', async () => {
    reset();
    const order = await seedOrder();
    const res = await request(app()).post(`${R}/orders/${order.id}/lines`).send({
        location_id: LOC, actor_label: 'Sam',
        receipts: [{ product_id: CLEAR, quantity: 1 }]
    });
    assert.equal(res.body.results[0].quantity_received_total, 1);
    assert.equal(res.body.results[0].over_received, false);

    const detail = await request(app()).get(`${R}/orders/${order.id}`);
    assert.equal(detail.body.order.fully_received, false);
});

test('a product not on the order is recorded as unexpected and does not fail the batch', async () => {
    reset();
    const order = await seedOrder();
    const res = await request(app()).post(`${R}/orders/${order.id}/lines`).send({
        location_id: LOC, actor_label: 'Sam',
        receipts: [{ product_id: FILTER, quantity: 1 }]
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.applied, 1);
    assert.equal(res.body.results[0].unexpected_item, true);

    const receipt = fake.db.order_receipts.find(r => r.product_id === FILTER);
    assert.equal(receipt.unexpected_item, true);

    const detail = await request(app()).get(`${R}/orders/${order.id}`);
    assert.equal(detail.body.unexpected.length, 1);
    assert.equal(detail.body.unexpected[0].product_id, FILTER);
});

test('receiving more than was ordered flags over_received but still posts', async () => {
    reset();
    const order = await seedOrder();
    const res = await request(app()).post(`${R}/orders/${order.id}/lines`).send({
        location_id: LOC, actor_label: 'Sam',
        receipts: [{ product_id: CLEAR, quantity: 6 }]     // ordered 4
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.results[0].over_received, true);
    assert.equal(res.body.results[0].quantity_received_total, 6);

    const level = fake.db.inventory_levels.find(l => l.product_id === CLEAR && l.location_id === LOC);
    assert.equal(level.on_hand, 11, 'stock still moves for the full scanned amount');
});

test('over-received accumulates correctly across two separate batches', async () => {
    reset();
    const order = await seedOrder();
    await request(app()).post(`${R}/orders/${order.id}/lines`).send({
        location_id: LOC, actor_label: 'Sam', receipts: [{ product_id: CLEAR, quantity: 3 }]
    });
    const second = await request(app()).post(`${R}/orders/${order.id}/lines`).send({
        location_id: LOC, actor_label: 'Sam', receipts: [{ product_id: CLEAR, quantity: 2 }]
    });
    assert.equal(second.body.results[0].over_received, true);
    assert.equal(second.body.results[0].quantity_received_total, 5);
});

test('a cancelled order refuses receiving outright', async () => {
    reset();
    const order = await seedOrder({ order_number: 'CHC-CANCEL', status: 'cancelled' });
    const res = await request(app()).post(`${R}/orders/${order.id}/lines`).send({
        location_id: LOC, actor_label: 'Sam', receipts: [{ product_id: CLEAR, quantity: 1 }]
    });
    assert.equal(res.status, 400);
    assert.equal(fake.db.stock_movements.length, 0);
    assert.equal(fake.db.order_receipts.length, 0);
});

test('a closed order refuses receiving outright', async () => {
    reset();
    const order = await seedOrder({ order_number: 'CHC-CLOSED', status: 'closed' });
    const res = await request(app()).post(`${R}/orders/${order.id}/lines`).send({
        location_id: LOC, actor_label: 'Sam', receipts: [{ product_id: CLEAR, quantity: 1 }]
    });
    assert.equal(res.status, 400);
    assert.equal(fake.db.stock_movements.length, 0);
});

test('a name is required so the receipt can be attributed', async () => {
    reset();
    const order = await seedOrder();
    const res = await request(app()).post(`${R}/orders/${order.id}/lines`).send({
        location_id: LOC, receipts: [{ product_id: CLEAR, quantity: 1 }]
    });
    assert.equal(res.status, 400);
    assert.equal(fake.db.stock_movements.length, 0);
});

test('a valid location is required', async () => {
    reset();
    const order = await seedOrder();
    const res = await request(app()).post(`${R}/orders/${order.id}/lines`).send({
        actor_label: 'Sam', receipts: [{ product_id: CLEAR, quantity: 1 }]
    });
    assert.equal(res.status, 400);
});

test('a zero or negative quantity line fails without touching the rest of the batch', async () => {
    reset();
    const order = await seedOrder();
    const res = await request(app()).post(`${R}/orders/${order.id}/lines`).send({
        location_id: LOC, actor_label: 'Sam',
        receipts: [{ product_id: CLEAR, quantity: 0 }, { product_id: TAPE, quantity: 2 }]
    });
    assert.equal(res.body.applied, 1);
    assert.equal(res.body.failed, 1);
    assert.equal(res.body.results[0].ok, false);
    assert.equal(res.body.results[1].ok, true);
});

test('another company cannot receive against this order', async () => {
    reset();
    const order = await seedOrder();
    authCompany = { id: OTHER_CO, name: 'Other Shop', slug: 'other' };
    const res = await request(app()).post(`${R}/orders/${order.id}/lines`).send({
        location_id: LOC, actor_label: 'Sam', receipts: [{ product_id: CLEAR, quantity: 1 }]
    });
    assert.equal(res.status, 404);
});

test('no lines supplied is refused', async () => {
    reset();
    const order = await seedOrder();
    const res = await request(app()).post(`${R}/orders/${order.id}/lines`).send({
        location_id: LOC, actor_label: 'Sam', receipts: []
    });
    assert.equal(res.status, 400);
});

test('the module is refused when inventory is off for the company', async () => {
    reset({ settings: { enabled: false } });
    const res = await request(app()).get(`${R}/orders`);
    assert.equal(res.status, 403);
});

test('the fake knows every column migration 032 added for order_receipts', () => {
    const { KNOWN_COLUMNS } = require('./helpers/fake-supabase');
    assert.ok(KNOWN_COLUMNS && KNOWN_COLUMNS.order_receipts, 'KNOWN_COLUMNS.order_receipts must be exported');
    for (const col of ['order_id', 'product_id', 'quantity_received', 'unexpected_item', 'movement_id', 'actor_label']) {
        assert.ok(KNOWN_COLUMNS.order_receipts.has(col), `order_receipts.${col} missing from KNOWN_COLUMNS`);
    }
});
