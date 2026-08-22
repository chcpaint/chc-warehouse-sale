/**
 * tests/inventory-routes.test.js
 *
 * HTTP-level tests for the shop-floor inventory API: routing, the per-company
 * feature gate, tenant isolation, input validation and the full
 * consume -> auto-draft -> approve -> order flow.
 *
 * The database is stubbed (tests/helpers/fake-supabase.js) so these run
 * anywhere with no credentials. The SQL-level behaviour — the on-hand trigger,
 * the append-only rule, the unique constraints — is verified separately against
 * the real schema; the stub reproduces the same contract.
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { createFakeSupabase } = require('./helpers/fake-supabase');

// ------------------------------------------------------------------
// Stub the project modules the routes pull in, before requiring them.
// ------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '..');
const sent = { orders: [] };
let fake = createFakeSupabase();
let authCompany = null;

// The routes destructure `supabaseAdmin` at require time, so the stub has to be
// a stable object that forwards to whichever fake the current test installed.
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
        validEmails: (list) => list.filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim()))
    },
    [path.join(ROOT, 'utils/email.js')]: {
        sendOrderNotification: async (opts) => { sent.orders.push(opts); },
        sendInvoiceReady: async () => {},
        sendOrderClosed: async () => {}
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
const COMPANY_ID  = '11111111-1111-4111-8111-111111111111';
const OTHER_CO_ID = '22222222-2222-4222-8222-222222222222';
const LOCATION_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_LOC   = '44444444-4444-4444-8444-444444444444';
const PRODUCT_ID  = '55555555-5555-4555-8555-555555555555';
const RESTRICTED_LOC = '66666666-6666-4666-8666-666666666666';
const EQUIP_PRODUCT  = '77777777-7777-4777-8777-777777777777';

function seedDb(inventoryEnabled = true, overrides = {}) {
    return createFakeSupabase({
        companies: [
            { id: COMPANY_ID, name: 'Assured Collision', slug: 'assured',
              settings: { inventory: { enabled: inventoryEnabled, auto_draft: true, allow_negative: false, ...overrides } } },
            { id: OTHER_CO_ID, name: 'Other Shop', slug: 'other', settings: {} }
        ],
        company_locations: [
            { id: LOCATION_ID, company_id: COMPANY_ID, name: 'Burlington', is_active: true, supplier_branch_id: null, restrict_to_category: null },
            { id: RESTRICTED_LOC, company_id: COMPANY_ID, name: 'Halifax', is_active: true, restrict_to_category: 'Equip/Filter/Booth' },
            { id: OTHER_LOC, company_id: OTHER_CO_ID, name: 'Somewhere else', is_active: true }
        ],
        products: [
            { id: PRODUCT_ID, company_id: COMPANY_ID, sku: '2PCPSL', name: 'Two piece Paint Suit Large',
              brand: 'PPG', category: 'Masks/Suits', price: 84.48, case_qty: 20, is_active: true },
            { id: EQUIP_PRODUCT, company_id: COMPANY_ID, sku: 'BOOTH-1', name: 'Booth filter',
              brand: 'Camfil', category: 'Equip/Filter/Booth', price: 40, is_active: true }
        ],
        product_barcodes: [
            { id: 'bc-1', product_id: PRODUCT_ID, barcode: '0051131020474', symbology: 'ean_13', is_primary: true }
        ]
    });
}

function app() {
    const a = express();
    a.use(express.json());
    a.use('/api/store/:slug/inventory', inventoryStore);
    return a;
}

function reset(enabled = true, overrides = {}) {
    fake = seedDb(enabled, overrides);
    authCompany = { id: COMPANY_ID, name: 'Assured Collision', slug: 'assured' };
    sent.orders = [];
}

// ==================================================================
// FEATURE GATE + AUTH
// ==================================================================

test('an unauthenticated request is rejected', async () => {
    reset();
    authCompany = null;
    const res = await request(app()).get('/api/store/assured/inventory/levels?location_id=' + LOCATION_ID);
    assert.equal(res.status, 401);
});

test('a company without the module gets a clean 403, not a 500', async () => {
    reset(false);
    const res = await request(app()).get('/api/store/assured/inventory/levels?location_id=' + LOCATION_ID);
    assert.equal(res.status, 403);
    assert.match(res.body.error, /not enabled/i);
});

test('inventory is off by default for a company with empty settings', async () => {
    reset();
    fake.db.companies[0].settings = {};
    const res = await request(app()).get('/api/store/assured/inventory/summary?location_id=' + LOCATION_ID);
    assert.equal(res.status, 403);
});

// ==================================================================
// TENANT ISOLATION
// ==================================================================

test('another company\'s location is refused', async () => {
    reset();
    const res = await request(app()).get('/api/store/assured/inventory/levels?location_id=' + OTHER_LOC);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /valid location/i);
});

test('a movement cannot be posted to another company\'s location', async () => {
    reset();
    const res = await request(app()).post('/api/store/assured/inventory/movements').send({
        location_id: OTHER_LOC, product_id: PRODUCT_ID, movement_type: 'consume', quantity: 1, actor_label: 'Sam'
    });
    assert.equal(res.status, 400);
    assert.equal(fake.db.stock_movements.length, 0);
});

test('a malformed location id is refused rather than queried', async () => {
    reset();
    const res = await request(app()).get('/api/store/assured/inventory/levels?location_id=not-a-uuid');
    assert.equal(res.status, 400);
});

// ==================================================================
// SCAN LOOKUP
// ==================================================================

test('a UPC-A scan resolves the product stored as EAN-13', async () => {
    reset();
    const res = await request(app())
        .get(`/api/store/assured/inventory/lookup?code=051131020474&location_id=${LOCATION_ID}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.product.sku, '2PCPSL');
    assert.equal(res.body.matched_by, 'barcode');
});

test('a part number typed or scanned from a shelf label resolves too', async () => {
    reset();
    const res = await request(app())
        .get(`/api/store/assured/inventory/lookup?code=2PCPSL&location_id=${LOCATION_ID}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.matched_by, 'sku');
});

test('an unknown code returns 404 with the code echoed back', async () => {
    reset();
    const res = await request(app())
        .get(`/api/store/assured/inventory/lookup?code=999999999999&location_id=${LOCATION_ID}`);
    assert.equal(res.status, 404);
    assert.equal(res.body.code, '999999999999');
});

test('a barcode shared by two SKUs asks which item, rather than guessing', async () => {
    reset();
    // The real CHC master file has 11 of these.
    fake.db.product_barcodes.push({ id: 'bc-2', product_id: EQUIP_PRODUCT, barcode: '0051131020474' });
    const res = await request(app())
        .get(`/api/store/assured/inventory/lookup?code=051131020474&location_id=${LOCATION_ID}`);
    assert.equal(res.status, 300);
    assert.equal(res.body.ambiguous, true);
    assert.equal(res.body.candidates.length, 2);
});

// ==================================================================
// MOVEMENTS
// ==================================================================

test('receiving stock raises on-hand and stamps the balance', async () => {
    reset();
    const res = await request(app()).post('/api/store/assured/inventory/movements').send({
        location_id: LOCATION_ID, product_id: PRODUCT_ID, movement_type: 'receive',
        quantity: 10, actor_label: 'Sam'
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.on_hand, 10);
    assert.equal(fake.db.stock_movements[0].qty_change, 10);
});

test('consuming stock writes a negative ledger row', async () => {
    reset();
    await post({ movement_type: 'receive', quantity: 10 });
    const res = await post({ movement_type: 'consume', quantity: 3 });
    assert.equal(res.status, 201);
    assert.equal(res.body.on_hand, 7);
    assert.equal(fake.db.stock_movements[1].qty_change, -3);
});

test('a cycle count posts the difference, not the count itself', async () => {
    reset();
    await post({ movement_type: 'receive', quantity: 10 });
    const res = await post({ movement_type: 'count', quantity: 8 });
    assert.equal(res.status, 201);
    assert.equal(res.body.on_hand, 8);
    assert.equal(fake.db.stock_movements[1].qty_change, -2);
});

test('overconsumption is blocked with a useful message', async () => {
    reset();
    await post({ movement_type: 'receive', quantity: 2 });
    const res = await post({ movement_type: 'consume', quantity: 5 });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /Only 2 on hand/);
    assert.equal(fake.db.stock_movements.length, 1);
});

test('overconsumption is allowed when the company opts in', async () => {
    reset(true, { allow_negative: true });
    const res = await post({ movement_type: 'consume', quantity: 5 });
    assert.equal(res.status, 201);
    assert.equal(res.body.on_hand, -5);
});

test('a movement without a name is refused — the ledger needs a who', async () => {
    reset();
    const res = await request(app()).post('/api/store/assured/inventory/movements').send({
        location_id: LOCATION_ID, product_id: PRODUCT_ID, movement_type: 'consume', quantity: 1
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /name/i);
});

test('the actor name is recorded on every ledger row', async () => {
    reset();
    await post({ movement_type: 'receive', quantity: 5, actor_label: 'Priya T' });
    assert.equal(fake.db.stock_movements[0].actor_label, 'Priya T');
    assert.equal(fake.db.stock_movements[0].actor_type, 'store');
});

test('a job reference is carried onto the movement', async () => {
    reset();
    await post({ movement_type: 'receive', quantity: 5 });
    await post({ movement_type: 'consume', quantity: 1, job_ref: 'RO-4821' });
    assert.equal(fake.db.stock_movements[1].job_ref, 'RO-4821');
});

test('HTML in a free-text field is stripped before it is stored', async () => {
    reset();
    await post({ movement_type: 'receive', quantity: 1, reason: '<script>alert(1)</script>spilled' });
    assert.equal(fake.db.stock_movements[0].reason, 'alert(1)spilled');
});

test('an unsupported movement type is refused', async () => {
    reset();
    const res = await post({ movement_type: 'transfer_out', quantity: 1 });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Movement type must be/);
});

test('a zero or negative quantity is refused', async () => {
    reset();
    assert.equal((await post({ movement_type: 'consume', quantity: 0 })).status, 400);
    assert.equal((await post({ movement_type: 'consume', quantity: -4 })).status, 400);
    assert.equal((await post({ movement_type: 'consume', quantity: 'lots' })).status, 400);
});

test('a category-locked location refuses stock it does not carry', async () => {
    reset();
    const res = await request(app()).post('/api/store/assured/inventory/movements').send({
        location_id: RESTRICTED_LOC, product_id: PRODUCT_ID,
        movement_type: 'receive', quantity: 1, actor_label: 'Sam'
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /only stocks/i);
});

test('a category-locked location accepts the stock it does carry', async () => {
    reset();
    const res = await request(app()).post('/api/store/assured/inventory/movements').send({
        location_id: RESTRICTED_LOC, product_id: EQUIP_PRODUCT,
        movement_type: 'receive', quantity: 1, actor_label: 'Sam'
    });
    assert.equal(res.status, 201);
});

test('an inactive product cannot be moved', async () => {
    reset();
    fake.db.products[0].is_active = false;
    const res = await post({ movement_type: 'receive', quantity: 1 });
    assert.equal(res.status, 400);
});

// ==================================================================
// BULK / OFFLINE FLUSH
// ==================================================================

test('a batch applies the good lines and reports the bad ones', async () => {
    reset();
    await post({ movement_type: 'receive', quantity: 20 });
    const res = await request(app()).post('/api/store/assured/inventory/movements/bulk').send({
        location_id: LOCATION_ID,
        actor_label: 'Sam',
        movements: [
            { product_id: PRODUCT_ID, movement_type: 'consume', quantity: 2 },
            { product_id: PRODUCT_ID, movement_type: 'consume', quantity: 0 },       // invalid
            { product_id: 'not-a-uuid', movement_type: 'consume', quantity: 1 },     // invalid
            { product_id: PRODUCT_ID, movement_type: 'consume', quantity: 3 }
        ]
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.applied, 2);
    assert.equal(res.body.failed, 2);
    assert.equal(fake.db.inventory_levels[0].on_hand, 15);
});

test('an empty or oversized batch is refused', async () => {
    reset();
    const empty = await request(app()).post('/api/store/assured/inventory/movements/bulk')
        .send({ location_id: LOCATION_ID, actor_label: 'Sam', movements: [] });
    assert.equal(empty.status, 400);

    const huge = await request(app()).post('/api/store/assured/inventory/movements/bulk')
        .send({ location_id: LOCATION_ID, actor_label: 'Sam',
                movements: Array(501).fill({ product_id: PRODUCT_ID, movement_type: 'consume', quantity: 1 }) });
    assert.equal(huge.status, 400);
});

// ==================================================================
// REORDER POINTS + AUTO-DRAFT
// ==================================================================

test('reorder points can be set, and on_hand cannot be set through them', async () => {
    reset();
    await post({ movement_type: 'receive', quantity: 10 });
    const res = await request(app()).put(`/api/store/assured/inventory/levels/${PRODUCT_ID}`).send({
        location_id: LOCATION_ID, min_point: 4, max_point: 20, bin_location: 'A-03', on_hand: 9999
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.level.min_point, 4);
    assert.equal(res.body.level.on_hand, 10, 'on_hand must only ever move through the ledger');
});

test('a max below the min is refused', async () => {
    reset();
    const res = await request(app()).put(`/api/store/assured/inventory/levels/${PRODUCT_ID}`)
        .send({ location_id: LOCATION_ID, min_point: 10, max_point: 2 });
    assert.equal(res.status, 400);
});

test('crossing the minimum drafts a replenishment line up to the max', async () => {
    reset();
    await post({ movement_type: 'receive', quantity: 10 });
    await setPoints({ min_point: 4, max_point: 20 });
    const res = await post({ movement_type: 'consume', quantity: 7 });   // 10 -> 3, below min 4

    assert.equal(res.status, 201);
    assert.ok(res.body.replenishment, 'expected a replenishment draft');
    assert.equal(res.body.replenishment.quantity, 17);                    // 20 - 3
    assert.equal(fake.db.replenishment_orders.length, 1);
    assert.equal(fake.db.replenishment_orders[0].status, 'pending_approval');
});

test('further scans top up the same queue rather than opening a second one', async () => {
    reset();
    await post({ movement_type: 'receive', quantity: 10 });
    await setPoints({ min_point: 4, max_point: 20 });
    await post({ movement_type: 'consume', quantity: 7 });
    await post({ movement_type: 'consume', quantity: 1 });                // 3 -> 2

    assert.equal(fake.db.replenishment_orders.length, 1);
    assert.equal(fake.db.replenishment_order_lines.length, 1);
    assert.equal(Number(fake.db.replenishment_order_lines[0].quantity), 18);   // 20 - 2
});

test('nothing is drafted while stock stays above the minimum', async () => {
    reset();
    await post({ movement_type: 'receive', quantity: 10 });
    await setPoints({ min_point: 4, max_point: 20 });
    const res = await post({ movement_type: 'consume', quantity: 1 });
    assert.equal(res.body.replenishment, null);
    assert.equal(fake.db.replenishment_orders.length, 0);
});

test('an item with no minimum never auto-orders', async () => {
    reset();
    await post({ movement_type: 'receive', quantity: 2 });
    const res = await post({ movement_type: 'consume', quantity: 2 });   // down to zero
    assert.equal(res.body.replenishment, null);
});

test('auto-draft can be switched off per company', async () => {
    reset(true, { auto_draft: false });
    await post({ movement_type: 'receive', quantity: 10 });
    await setPoints({ min_point: 4, max_point: 20 });
    const res = await post({ movement_type: 'consume', quantity: 8 });
    assert.equal(res.body.replenishment, null);
    assert.equal(fake.db.replenishment_orders.length, 0);
});

// ==================================================================
// APPROVAL -> REAL CHC ORDER
// ==================================================================

async function queueOne() {
    await post({ movement_type: 'receive', quantity: 10 });
    await setPoints({ min_point: 4, max_point: 20 });
    await post({ movement_type: 'consume', quantity: 7 });
    return fake.db.replenishment_orders[0].id;
}

test('approving a queue raises a real order and emails the branch', async () => {
    reset();
    const id = await queueOne();
    const res = await request(app()).post(`/api/store/assured/inventory/replenishment/${id}/approve`).send({
        po_number: 'PO-9001', contact_name: 'Dana', contact_email: 'dana@shop.com', actor_label: 'Dana'
    });

    assert.equal(res.status, 201);
    assert.equal(fake.db.orders.length, 1);

    const order = fake.db.orders[0];
    assert.equal(order.po_number, 'PO-9001');
    assert.equal(order.location_id, LOCATION_ID);
    assert.equal(order.items.length, 1);
    assert.equal(order.items[0].quantity, 17);
    assert.equal(order.items[0].unit_price, 84.48, 'price must come from the server, never the client');
    assert.equal(order.total, Math.round(17 * 84.48 * 100) / 100);
    assert.equal(order.status, 'pending');

    assert.equal(sent.orders.length, 1, 'the servicing branch must be notified');
    assert.equal(fake.db.replenishment_orders[0].status, 'approved');
    assert.equal(fake.db.replenishment_orders[0].order_id, order.id);
});

test('an active promotion is honoured on an approved replenishment', async () => {
    reset();
    const id = await queueOne();
    const now = new Date();
    fake.db.promotions.push({
        id: 'promo-1', company_id: COMPANY_ID, product_id: PRODUCT_ID, promo_price: 60,
        is_active: true,
        starts_at: new Date(now.getTime() - 86400000).toISOString(),
        ends_at: new Date(now.getTime() + 86400000).toISOString()
    });

    await request(app()).post(`/api/store/assured/inventory/replenishment/${id}/approve`).send({
        po_number: 'PO-9002', contact_name: 'Dana', contact_email: 'dana@shop.com', actor_label: 'Dana'
    });

    assert.equal(fake.db.orders[0].items[0].unit_price, 60);
    assert.equal(fake.db.orders[0].items[0].was_promo, true);
});

test('approval requires a PO number, a name and a valid email', async () => {
    reset();
    const id = await queueOne();
    const base = { contact_name: 'Dana', contact_email: 'dana@shop.com', actor_label: 'Dana' };

    const noPo = await request(app()).post(`/api/store/assured/inventory/replenishment/${id}/approve`).send(base);
    assert.equal(noPo.status, 400);

    const badEmail = await request(app()).post(`/api/store/assured/inventory/replenishment/${id}/approve`)
        .send({ ...base, po_number: 'PO-1', contact_email: 'not-an-email' });
    assert.equal(badEmail.status, 400);

    assert.equal(fake.db.orders.length, 0);
});

test('the same queue cannot be approved twice', async () => {
    reset();
    const id = await queueOne();
    const body = { po_number: 'PO-1', contact_name: 'Dana', contact_email: 'dana@shop.com', actor_label: 'Dana' };

    assert.equal((await request(app()).post(`/api/store/assured/inventory/replenishment/${id}/approve`).send(body)).status, 201);
    const second = await request(app()).post(`/api/store/assured/inventory/replenishment/${id}/approve`).send(body);
    assert.equal(second.status, 404);
    assert.equal(fake.db.orders.length, 1, 'a double approval must not raise a second order');
});

test('another company cannot approve this company\'s queue', async () => {
    reset();
    const id = await queueOne();
    authCompany = { id: OTHER_CO_ID, name: 'Other Shop', slug: 'other' };
    fake.db.companies[1].settings = { inventory: { enabled: true } };

    const res = await request(app()).post(`/api/store/other/inventory/replenishment/${id}/approve`).send({
        po_number: 'PO-X', contact_name: 'Mallory', contact_email: 'm@evil.com', actor_label: 'Mallory'
    });
    assert.equal(res.status, 404);
    assert.equal(fake.db.orders.length, 0);
});

test('rejecting requires a reason and records it', async () => {
    reset();
    const id = await queueOne();

    const noReason = await request(app()).post(`/api/store/assured/inventory/replenishment/${id}/reject`)
        .send({ actor_label: 'Dana' });
    assert.equal(noReason.status, 400);

    const ok = await request(app()).post(`/api/store/assured/inventory/replenishment/${id}/reject`)
        .send({ actor_label: 'Dana', reason: 'Ordering direct from PPG this week' });
    assert.equal(ok.status, 200);
    assert.equal(fake.db.replenishment_orders[0].status, 'rejected');
    assert.equal(fake.db.replenishment_orders[0].decision_reason, 'Ordering direct from PPG this week');
});

test('an empty queue cannot be approved into an empty order', async () => {
    reset();
    const id = await queueOne();
    fake.db.replenishment_order_lines.length = 0;

    const res = await request(app()).post(`/api/store/assured/inventory/replenishment/${id}/approve`).send({
        po_number: 'PO-1', contact_name: 'Dana', contact_email: 'dana@shop.com', actor_label: 'Dana'
    });
    assert.equal(res.status, 400);
    assert.equal(fake.db.orders.length, 0);
});

test('a line can be edited, and zeroing it removes it', async () => {
    reset();
    const id = await queueOne();
    const lineId = fake.db.replenishment_order_lines[0].id;

    const edited = await request(app()).put(`/api/store/assured/inventory/replenishment/${id}/lines/${lineId}`)
        .send({ quantity: 5 });
    assert.equal(edited.status, 200);
    assert.equal(Number(fake.db.replenishment_order_lines[0].quantity), 5);

    const removed = await request(app()).put(`/api/store/assured/inventory/replenishment/${id}/lines/${lineId}`)
        .send({ quantity: 0 });
    assert.equal(removed.status, 200);
    assert.equal(fake.db.replenishment_order_lines.length, 0);
});

test('rebuilding the queue from levels picks up items already below min', async () => {
    reset(true, { auto_draft: false });
    await post({ movement_type: 'receive', quantity: 2 });
    await setPoints({ min_point: 5, max_point: 12 });
    assert.equal(fake.db.replenishment_orders.length, 0);

    const res = await request(app()).post('/api/store/assured/inventory/replenishment/refresh')
        .send({ location_id: LOCATION_ID, actor_label: 'Dana' });
    assert.equal(res.status, 200);
    assert.equal(res.body.queued, 1);
    assert.equal(Number(fake.db.replenishment_order_lines[0].quantity), 10);   // 12 - 2
});

// ==================================================================
// READ SURFACES
// ==================================================================

test('the summary counts low and out separately', async () => {
    reset();
    await post({ movement_type: 'receive', quantity: 3 });
    await setPoints({ min_point: 5, max_point: 10 });
    await request(app()).post('/api/store/assured/inventory/movements').send({
        location_id: LOCATION_ID, product_id: EQUIP_PRODUCT, movement_type: 'receive', quantity: 1, actor_label: 'Sam'
    });
    await request(app()).post('/api/store/assured/inventory/movements').send({
        location_id: LOCATION_ID, product_id: EQUIP_PRODUCT, movement_type: 'consume', quantity: 1, actor_label: 'Sam'
    });

    const res = await request(app()).get(`/api/store/assured/inventory/summary?location_id=${LOCATION_ID}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.summary.low, 1);
    assert.equal(res.body.summary.out, 1);
});

test('history returns newest movements with the balance after each', async () => {
    reset();
    await post({ movement_type: 'receive', quantity: 10 });
    await post({ movement_type: 'consume', quantity: 4 });

    const res = await request(app()).get(`/api/store/assured/inventory/movements?location_id=${LOCATION_ID}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.movements.length, 2);
    assert.ok(res.body.movements.every(m => m.on_hand_after !== undefined));
});

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------
function post(body) {
    return request(app()).post('/api/store/assured/inventory/movements').send({
        location_id: LOCATION_ID, product_id: PRODUCT_ID, actor_label: 'Sam', ...body
    });
}

function setPoints(body) {
    return request(app()).put(`/api/store/assured/inventory/levels/${PRODUCT_ID}`)
        .send({ location_id: LOCATION_ID, ...body });
}
