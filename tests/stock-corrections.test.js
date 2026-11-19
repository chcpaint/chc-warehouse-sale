/**
 * tests/stock-corrections.test.js
 *
 * A manager or admin putting right a finished count or a posted delivery from
 * the console (routes/stock-corrections-admin.js, migration 069).
 *
 * What matters most: stock moves by exactly the difference, nothing posted is
 * rewritten, a reason is always kept, only managers can change anything, and
 * nobody reaches a customer outside the Orders screen's scope.
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
let admin = null;

const supabaseProxy = new Proxy({}, {
    get: (_t, prop) => { const v = fake[prop]; return typeof v === 'function' ? v.bind(fake) : v; }
});

const stubs = {
    [path.join(ROOT, 'utils/supabase.js')]: { supabaseAdmin: supabaseProxy },
    [path.join(ROOT, 'utils/sanitize.js')]: {
        stripHtml: s => String(s === undefined || s === null ? '' : s).replace(/<[^>]*>/g, ''),
        sanitizeObject: o => o,
        isValidUUID: v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '')),
        generateSlug: s => s,
        validateEmail: () => true
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
const routes = require('../routes/stock-corrections-admin');
const { canCorrect } = require('../utils/inventory-corrections');

// ------------------------------------------------------------------
const DIST = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CO = '11111111-1111-4111-8111-111111111111';
const OTHER_CO = '22222222-2222-4222-8222-222222222222';
const LOC = '33333333-3333-4333-8333-333333333333';
const LOC_B = '44444444-4444-4444-8444-444444444444';
const BRANCH = '99999999-9999-4999-8999-999999999999';
const CLEAR = '55555555-5555-4555-8555-555555555555';
const TAPE = '77777777-7777-4777-8777-777777777777';
const SESSION = '66666666-6666-4666-8666-666666666666';
const LINE = '66666666-6666-4666-8666-666666666667';
const ORDER = '88888888-8888-4888-8888-888888888888';

const SUPER = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'super_admin', name: 'Adam', email: 'adam@example.com', distributor_id: DIST };
const DESK = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', role: 'order_desk', name: 'Desk', email: 'desk@example.com', branch_id: BRANCH, is_branch_manager: false, distributor_id: DIST };
const BRANCH_MGR = { ...DESK, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Branch Mgr', is_branch_manager: true };

function reset({ allowNegative = false, sessionStatus = 'committed' } = {}) {
    fake = createFakeSupabase({
        companies: [
            { id: CO, name: 'Concord Collision', slug: 'concord', distributor_id: DIST, settings: { inventory: { enabled: true, allow_negative: allowNegative } } },
            { id: OTHER_CO, name: 'Elsewhere', slug: 'elsewhere', distributor_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', settings: {} }
        ],
        company_locations: [
            { id: LOC, company_id: CO, name: 'Concord', is_active: true, supplier_branch_id: BRANCH },
            { id: LOC_B, company_id: CO, name: 'Vaughan', is_active: true, supplier_branch_id: null }
        ],
        products: [
            { id: CLEAR, company_id: CO, sku: 'PRF611N', name: 'ProForm Clear', is_active: true },
            { id: TAPE, company_id: CO, sku: 'MMM06334', name: '3M Masking Tape', is_active: true }
        ],
        inventory_levels: [
            { id: 'lvl-1', company_id: CO, location_id: LOC, product_id: CLEAR, on_hand: 12, is_tracked: true },
            { id: 'lvl-2', company_id: CO, location_id: LOC, product_id: TAPE, on_hand: 6, is_tracked: true }
        ],
        inventory_count_sessions: [
            { id: SESSION, company_id: CO, location_id: LOC, name: 'November shelf count', status: sessionStatus, committed_by: 'Sam', created_at: '2026-11-18T14:00:00Z', committed_at: '2026-11-18T15:00:00Z' }
        ],
        inventory_count_lines: [
            { id: LINE, session_id: SESSION, product_id: CLEAR, sku: 'PRF611N', name: 'ProForm Clear', counted_qty: 12, expected_qty: 9, variance: 3, counted_by: 'Sam' }
        ],
        orders: [
            { id: ORDER, company_id: CO, order_number: 'CHC-2001', location_id: LOC, status: 'out_on_delivery',
              items: [{ product_id: TAPE, sku: 'MMM06334', name: '3M Masking Tape', quantity: 6, unit_price: 10 }] }
        ],
        order_receipts: [
            { id: 'r1', company_id: CO, order_id: ORDER, location_id: LOC, product_id: TAPE, sku: 'MMM06334', name: '3M Masking Tape',
              quantity_received: 6, quantity_ordered: 6, unexpected_item: false, actor_label: 'Sam', actor_type: 'store', created_at: '2026-11-18T13:00:00Z' }
        ],
        audit_log: []
    });
    admin = SUPER;
}

function app() {
    const a = express();
    a.use(express.json());
    a.use((req, res, next) => { req.admin = admin; next(); });
    a.use('/api/admin/companies/:companyId/stock-corrections', routes);
    return a;
}
const B = `/api/admin/companies/${CO}/stock-corrections`;
const onHand = pid => Number(fake.db.inventory_levels.find(l => l.product_id === pid && l.location_id === LOC).on_hand);

// ------------------------------------------------------------------
test('who counts as a manager or admin', () => {
    assert.equal(canCorrect({ role: 'super_admin' }), true);
    assert.equal(canCorrect({ role: 'admin' }), true);
    assert.equal(canCorrect({ role: 'order_manager' }), true);
    assert.equal(canCorrect({ role: 'order_desk', is_branch_manager: true }), true);
    assert.equal(canCorrect({ role: 'order_desk' }), false);
    assert.equal(canCorrect({ role: 'sales_director' }), false);
    assert.equal(canCorrect(null), false);
});

test('a committed count: stock moves by the difference only, and the reason is kept', async () => {
    reset();
    const res = await request(app()).post(`${B}/counts/${SESSION}/lines/${LINE}`)
        .send({ counted_qty: 10, reason: 'Recounted the shelf' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.mode, 'committed');
    assert.equal(res.body.qty_change, -2);
    assert.equal(onHand(CLEAR), 10);

    const mv = fake.db.stock_movements.at(-1);
    assert.equal(mv.movement_type, 'adjust');
    assert.equal(Number(mv.qty_change), -2);
    assert.equal(mv.source_doc_type, 'count_correction');
    assert.equal(mv.source_doc_id, SESSION);
    assert.equal(mv.actor_type, 'admin');

    const c = fake.db.inventory_corrections[0];
    assert.equal(c.kind, 'count'); assert.equal(Number(c.old_qty), 12); assert.equal(Number(c.new_qty), 10);
    assert.equal(c.movement_id, mv.id); assert.equal(c.reason, 'Recounted the shelf'); assert.equal(c.actor_label, 'Adam');

    const line = fake.db.inventory_count_lines[0];
    assert.equal(Number(line.counted_qty), 10);
    assert.equal(Number(line.variance), 1, 'variance is against what the system had at count time');
    assert.match(line.note, /Changed from 12 to 10 by Adam/);
    assert.equal(fake.db.audit_log.at(-1).action, 'count_corrected');
});

test('an open count is simply changed: nothing is posted yet', async () => {
    reset({ sessionStatus: 'open' });
    const res = await request(app()).post(`${B}/counts/${SESSION}/lines/${LINE}`)
        .send({ counted_qty: 11, reason: 'Sam scanned one twice' });
    assert.equal(res.status, 200);
    assert.equal(res.body.mode, 'open');
    assert.equal(fake.db.stock_movements.length, 0);
    assert.equal(fake.db.inventory_corrections.length, 0);
    assert.equal(Number(fake.db.inventory_count_lines[0].counted_qty), 11);
});

test('a correction needs a reason and a real change', async () => {
    reset();
    let res = await request(app()).post(`${B}/counts/${SESSION}/lines/${LINE}`).send({ counted_qty: 10 });
    assert.equal(res.status, 400); assert.match(res.body.error, /why/i);
    res = await request(app()).post(`${B}/counts/${SESSION}/lines/${LINE}`).send({ counted_qty: 12, reason: 'no change' });
    assert.equal(res.status, 400); assert.match(res.body.error, /already says 12/);
    res = await request(app()).post(`${B}/counts/${SESSION}/lines/${LINE}`).send({ counted_qty: -1, reason: 'negative' });
    assert.equal(res.status, 400);
    assert.equal(fake.db.stock_movements.length, 0);
});

test('a correction that would take stock below zero is refused unless the shop allows it', async () => {
    reset();
    fake.db.inventory_levels[0].on_hand = 1;   // most of it has been used since
    let res = await request(app()).post(`${B}/counts/${SESSION}/lines/${LINE}`).send({ counted_qty: 8, reason: 'miscounted' });
    assert.equal(res.status, 409);
    assert.equal(fake.db.inventory_corrections.length, 0);

    reset({ allowNegative: true });
    fake.db.inventory_levels[0].on_hand = 1;
    res = await request(app()).post(`${B}/counts/${SESSION}/lines/${LINE}`).send({ counted_qty: 8, reason: 'miscounted' });
    assert.equal(res.status, 200);
    assert.equal(onHand(CLEAR), -3);
});

test('a delivery posted wrong: received 6, really 4', async () => {
    reset();
    const before = await request(app()).get(`${B}/orders/${ORDER}`);
    assert.equal(before.status, 200);
    assert.equal(before.body.receipt_count, 1);
    assert.equal(before.body.lines[0].quantity_received, 6);
    assert.equal(before.body.can_correct, true);

    const res = await request(app()).post(`${B}/orders/${ORDER}`)
        .send({ product_id: TAPE, received_qty: 4, reason: 'Box was scanned twice' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.qty_change, -2);
    assert.equal(onHand(TAPE), 4);

    const receipt = fake.db.order_receipts.at(-1);
    assert.equal(Number(receipt.quantity_received), -2);
    assert.equal(receipt.exception_type, 'correction');
    assert.equal(receipt.actor_type, 'admin');
    assert.ok(receipt.movement_id);
    assert.equal(fake.db.order_receipts[0].quantity_received, 6, 'the original receipt is never rewritten');

    const after = await request(app()).get(`${B}/orders/${ORDER}`);
    assert.equal(after.body.lines[0].quantity_received, 4);
    assert.equal(after.body.corrections.length, 1);
    assert.equal(fake.db.audit_log.at(-1).action, 'receipt_corrected');
});

test('an item that was never on the order or received cannot be "corrected" onto it', async () => {
    reset();
    const res = await request(app()).post(`${B}/orders/${ORDER}`).send({ product_id: CLEAR, received_qty: 3, reason: 'extra' });
    assert.equal(res.status, 400);
    assert.equal(fake.db.stock_movements.length, 0);
});

test('an order-desk account can look but not change; a branch manager can change', async () => {
    reset();
    admin = DESK;
    const look = await request(app()).get(`${B}/counts/${SESSION}`);
    assert.equal(look.status, 200);
    assert.equal(look.body.can_correct, false);
    let res = await request(app()).post(`${B}/counts/${SESSION}/lines/${LINE}`).send({ counted_qty: 10, reason: 'recount' });
    assert.equal(res.status, 403);
    res = await request(app()).post(`${B}/orders/${ORDER}`).send({ product_id: TAPE, received_qty: 4, reason: 'twice' });
    assert.equal(res.status, 403);
    assert.equal(fake.db.stock_movements.length, 0);

    admin = BRANCH_MGR;
    res = await request(app()).post(`${B}/counts/${SESSION}/lines/${LINE}`).send({ counted_qty: 10, reason: 'recount' });
    assert.equal(res.status, 200);
    assert.equal(fake.db.inventory_corrections[0].actor_label, 'Branch Mgr');
});

test('an order-desk account only sees counts at locations its branch serves', async () => {
    reset();
    fake.db.inventory_count_sessions.push({ id: '66666666-6666-4666-8666-000000000001', company_id: CO, location_id: LOC_B, name: 'Vaughan', status: 'committed', created_at: '2026-11-18T10:00:00Z' });
    admin = DESK;
    const list = await request(app()).get(`${B}/counts`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.counts.map(c => c.location_name), ['Concord']);
    const other = await request(app()).get(`${B}/counts/66666666-6666-4666-8666-000000000001`);
    assert.equal(other.status, 404);
});

test("another distributor's customer is not found, whatever the role", async () => {
    reset();
    const res = await request(app()).get(`/api/admin/companies/${OTHER_CO}/stock-corrections/counts`);
    assert.equal(res.status, 404);
});

test('a company admin works only on their own company', async () => {
    reset();
    admin = { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', role: 'admin', name: 'Owner', company_id: OTHER_CO };
    const res = await request(app()).get(`${B}/counts`);
    assert.equal(res.status, 404);
    admin = { ...admin, company_id: CO };
    const ok = await request(app()).post(`${B}/counts/${SESSION}/lines/${LINE}`).send({ counted_qty: 13, reason: 'found one more' });
    assert.equal(ok.status, 200);
    assert.equal(onHand(CLEAR), 13);
});

test('the console list shows committed and open counts, newest first', async () => {
    reset();
    fake.db.inventory_count_sessions.push({ id: '66666666-6666-4666-8666-000000000002', company_id: CO, location_id: LOC, name: 'Old', status: 'cancelled', created_at: '2026-10-01T10:00:00Z' });
    const res = await request(app()).get(`${B}/counts`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.counts.map(c => c.name), ['November shelf count']);
    assert.equal(res.body.can_correct, true);
});
