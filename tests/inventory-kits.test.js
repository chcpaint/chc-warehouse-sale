/**
 * tests/inventory-kits.test.js
 *
 * Repair kits: resolution, preview, consumption, tenancy, and the failure paths
 * that matter more than the happy one — a kit that is half-applied to a job, or
 * one that expenses a product the shop never agreed it meant.
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
let authAdmin = { id: 'admin-1', role: 'super_admin', company_id: null };

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
        requireAdminAuth: (req, res, next) => { req.admin = authAdmin; next(); },
        requireSuperAdmin: (req, res, next) => next(),
        requireCompanyAccess: (req, res, next) => { req.admin = authAdmin; next(); }
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
const inventoryAdmin = require('../routes/inventory-admin');
const kitsAdmin = require('../routes/inventory-kits-admin');

// ------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------
const CO       = '11111111-1111-4111-8111-111111111111';
const OTHER_CO = '22222222-2222-4222-8222-222222222222';
const LOC      = '33333333-3333-4333-8333-333333333333';
const EQUIP_LOC = '66666666-6666-4666-8666-666666666666';

const CLEAR    = '55555555-5555-4555-8555-555555555555';
const TAPE     = '77777777-7777-4777-8777-777777777777';
const FILTER   = '88888888-8888-4888-8888-888888888888';
const OTHER_PRODUCT = '99999999-9999-4999-8999-999999999999';

const KIT      = 'aaaaaaa1-1111-4111-8111-111111111111';
const PRIVATE_KIT = 'aaaaaaa2-2222-4222-8222-222222222222';
const FOREIGN_KIT = 'aaaaaaa3-3333-4333-8333-333333333333';

const LINE_CLEAR = 'bbbbbbb1-1111-4111-8111-111111111111';
const LINE_TAPE  = 'bbbbbbb2-2222-4222-8222-222222222222';
const LINE_GHOST = 'bbbbbbb3-3333-4333-8333-333333333333';   // SKU with no CHC product

function seed(opts = {}) {
    const settings = { enabled: true, auto_draft: false, allow_negative: false, ...(opts.settings || {}) };

    return createFakeSupabase({
        companies: [
            { id: CO, name: 'Assured Collision', slug: 'assured', settings: { inventory: settings } },
            { id: OTHER_CO, name: 'Other Shop', slug: 'other', settings: { inventory: { enabled: true } } }
        ],
        company_locations: [
            { id: LOC, company_id: CO, name: 'Burlington', is_active: true, restrict_to_category: null },
            { id: EQUIP_LOC, company_id: CO, name: 'Halifax', is_active: true, restrict_to_category: 'Equip/Filter/Booth' }
        ],
        products: [
            { id: CLEAR,  company_id: CO, sku: 'PRF611N', name: 'ProForm Clear Ga', category: 'Paint', price: 200, is_active: true },
            { id: TAPE,   company_id: CO, sku: 'MMM06334', name: '3M Masking Tape', category: 'Masking', price: 10, is_active: true },
            { id: FILTER, company_id: CO, sku: 'BOOTH-1', name: 'Booth filter', category: 'Equip/Filter/Booth', price: 40, is_active: true },
            { id: OTHER_PRODUCT, company_id: OTHER_CO, sku: 'PRF611N', name: 'Their clear', category: 'Paint', price: 199, is_active: true }
        ],
        repair_kits: [
            { id: KIT, company_id: null, name: 'Door Skin', description: 'Skin swap', source: 'skyline:weins', is_active: true, sort_order: 1 },
            { id: PRIVATE_KIT, company_id: CO, name: 'House blend', source: 'company', is_active: true, sort_order: 2 },
            { id: FOREIGN_KIT, company_id: OTHER_CO, name: 'Not yours', source: 'company', is_active: true, sort_order: 3 }
        ],
        kit_items: [
            { id: LINE_CLEAR, kit_id: KIT, sku: 'PRF611N',  product_id: null, quantity: 0.02, unit: 'each', sort_order: 1, needs_review: false },
            { id: LINE_TAPE,  kit_id: KIT, sku: 'MMM08852', product_id: null, quantity: 0.3,  unit: 'each', sort_order: 2, needs_review: false },
            { id: LINE_GHOST, kit_id: KIT, sku: 'FUS123EZ', product_id: null, quantity: 0.8,  unit: 'each', sort_order: 3, needs_review: false },
            { id: 'bbbbbbb4-4444-4444-8444-444444444444', kit_id: PRIVATE_KIT, sku: 'MMM06334', product_id: TAPE, quantity: 2, unit: 'each', sort_order: 1, needs_review: false }
        ],
        company_kit_access: [
            { company_id: CO, kit_id: KIT, enabled: true }
        ],
        inventory_levels: [
            { id: 'lvl-1', company_id: CO, location_id: LOC, product_id: CLEAR,  on_hand: 5, min_point: 1, max_point: 10, is_tracked: true },
            { id: 'lvl-2', company_id: CO, location_id: LOC, product_id: TAPE,   on_hand: 20, min_point: 5, max_point: 40, is_tracked: true },
            { id: 'lvl-3', company_id: CO, location_id: EQUIP_LOC, product_id: FILTER, on_hand: 3, is_tracked: true }
        ],
        ...(opts.extra || {})
    });
}

function storeApp() {
    const a = express();
    a.use(express.json());
    a.use('/api/store/:slug/inventory', inventoryStore);
    return a;
}

function adminApp() {
    const a = express();
    a.use(express.json());
    a.use('/api/admin/companies/:companyId/inventory', inventoryAdmin);
    return a;
}

/** Map the two resolvable lines and exclude the ghost, as CHC would. */
function mapKit() {
    fake.db.kit_product_map.push(
        { id: 'map-1', company_id: CO, kit_item_id: LINE_CLEAR, product_id: CLEAR, quantity: null, is_excluded: false },
        { id: 'map-2', company_id: CO, kit_item_id: LINE_TAPE,  product_id: TAPE,  quantity: null, is_excluded: false },
        { id: 'map-3', company_id: CO, kit_item_id: LINE_GHOST, product_id: null,  quantity: null, is_excluded: true }
    );
}

function reset(opts) {
    fake = seed(opts);
    authCompany = { id: CO, name: 'Assured Collision', slug: 'assured' };
    authAdmin = { id: 'aaaaaaaa-0000-4000-8000-000000000001', role: 'super_admin', company_id: null };
}

const S = '/api/store/assured/inventory/kits';

// ==================================================================
// LISTING AND ENTITLEMENT
// ==================================================================

test('a company sees the master kits granted to it and its own kits', async () => {
    reset();
    const res = await request(storeApp()).get(S);
    assert.equal(res.status, 200);
    const names = res.body.kits.map(k => k.name).sort();
    assert.deepEqual(names, ['Door Skin', 'House blend']);
});

test('another company\'s private kit is never listed', async () => {
    reset();
    const res = await request(storeApp()).get(S);
    assert.ok(!res.body.kits.some(k => k.name === 'Not yours'));
});

test('a master kit that has not been granted is not listed', async () => {
    reset();
    fake.db.company_kit_access[0].enabled = false;
    const res = await request(storeApp()).get(S);
    assert.deepEqual(res.body.kits.map(k => k.name), ['House blend']);
});

test('an unmapped kit is listed but reported as not ready', async () => {
    reset();
    const res = await request(storeApp()).get(S);
    const doorSkin = res.body.kits.find(k => k.name === 'Door Skin');
    assert.equal(doorSkin.ready, false);
    assert.equal(doorSkin.unresolved_count, 3);
    assert.equal(doorSkin.line_count, 0);
});

test('a company kit whose lines carry products directly needs no mapping', async () => {
    reset();
    const res = await request(storeApp()).get(S);
    const house = res.body.kits.find(k => k.name === 'House blend');
    assert.equal(house.ready, true);
    assert.equal(house.line_count, 1);
    assert.equal(house.estimated_cost, 20);         // 2 x $10
});

// ==================================================================
// PREVIEW
// ==================================================================

test('preview prices the kit and writes nothing', async () => {
    reset();
    mapKit();
    const before = fake.db.stock_movements.length;

    const res = await request(storeApp()).get(`${S}/${KIT}/preview?location_id=${LOC}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.blocked, false);
    assert.equal(res.body.lines.length, 2);
    assert.equal(res.body.excluded.length, 1);
    // 0.02 x $200 + 0.3 x $10 = 4 + 3
    assert.equal(res.body.total_cost, 7);
    assert.equal(fake.db.stock_movements.length, before);
});

test('the multiplier scales quantities and cost', async () => {
    reset();
    mapKit();
    const res = await request(storeApp()).get(`${S}/${KIT}/preview?location_id=${LOC}&multiplier=2`);
    assert.equal(res.body.multiplier, 2);
    assert.equal(res.body.total_cost, 14);
    assert.equal(res.body.lines.find(l => l.product_id === CLEAR).quantity, 0.04);
});

test('an unresolved line blocks the preview and says which SKU', async () => {
    reset();                       // nothing mapped
    const res = await request(storeApp()).get(`${S}/${KIT}/preview?location_id=${LOC}`);
    assert.equal(res.body.blocked, true);
    assert.equal(res.body.unresolved.length, 3);
    assert.match(res.body.blocked_reason, /not matched/i);
    assert.ok(res.body.unresolved.some(u => u.sku === 'FUS123EZ'));
});

test('preview flags a shortfall rather than silently going negative', async () => {
    reset();
    mapKit();
    fake.db.inventory_levels.find(l => l.product_id === CLEAR).on_hand = 0.01;

    const res = await request(storeApp()).get(`${S}/${KIT}/preview?location_id=${LOC}`);
    assert.equal(res.body.blocked, true);
    const clear = res.body.lines.find(l => l.product_id === CLEAR);
    assert.equal(clear.would_go_negative, true);
    assert.equal(clear.shortfall, 0.01);
    assert.match(res.body.blocked_reason, /not enough/i);
});

// ------------------------------------------------------------------
// Billing. A kit that expenses stock but bills nothing for it is the
// quietest way to lose money here: the consume succeeds, the ledger is
// correct, and the invoice is simply short. These cover that.
// ------------------------------------------------------------------

test('a line with no price blocks the preview instead of billing zero', async () => {
    reset();
    mapKit();
    fake.db.products.find(p => p.id === CLEAR).price = 0;

    const res = await request(storeApp()).get(`${S}/${KIT}/preview?location_id=${LOC}`);
    assert.equal(res.body.blocked, true);
    const clear = res.body.lines.find(l => l.product_id === CLEAR);
    assert.equal(clear.unpriced, true);
    assert.equal(clear.line_cost, 0);
    assert.match(res.body.blocked_reason, /no price/i);
});

test('a null price is treated the same as zero', async () => {
    reset();
    mapKit();
    fake.db.products.find(p => p.id === CLEAR).price = null;

    const res = await request(storeApp()).get(`${S}/${KIT}/preview?location_id=${LOC}`);
    assert.equal(res.body.blocked, true);
    assert.match(res.body.blocked_reason, /no price/i);
});

test('consuming a kit with an unpriced line is refused and writes nothing', async () => {
    reset();
    mapKit();
    fake.db.products.find(p => p.id === TAPE).price = 0;
    const before = fake.db.stock_movements.length;
    const headers = fake.db.kit_consumptions.length;

    const res = await request(storeApp())
        .post(`${S}/${KIT}/consume`)
        .send({ location_id: LOC, job_ref: 'RO-9001', actor_label: 'Sam' });

    assert.equal(res.status, 409);
    assert.match(res.body.error, /no price set/i);
    assert.equal(fake.db.stock_movements.length, before, 'no stock may move');
    assert.equal(fake.db.kit_consumptions.length, headers, 'no header may be written');
});

test('an unpriced line still blocks when the shop allows negative stock', async () => {
    reset({ settings: { allow_negative: true } });
    mapKit();
    fake.db.products.find(p => p.id === CLEAR).price = 0;

    const res = await request(storeApp()).get(`${S}/${KIT}/preview?location_id=${LOC}`);
    assert.equal(res.body.blocked, true, 'allow_negative is about stock, not about price');
    assert.match(res.body.blocked_reason, /no price/i);
});

test('the reference total is carried beside the live one', async () => {
    reset();
    mapKit();
    // Skyline's numbers for these two lines: 0.02 x 189.99 and 0.3 x 50.99.
    fake.db.kit_items.find(i => i.id === LINE_CLEAR).ref_unit_price = 189.99;
    fake.db.kit_items.find(i => i.id === LINE_TAPE).ref_unit_price  = 50.99;

    const res = await request(storeApp()).get(`${S}/${KIT}/preview?location_id=${LOC}`);
    assert.equal(res.body.blocked, false);
    assert.equal(res.body.total_cost, 7);
    // 0.02 x 189.99 = 3.7998, 0.3 x 50.99 = 15.297
    assert.equal(res.body.reference_total, 19.0968);
});

test('one line without a reference nulls the whole comparison', async () => {
    reset();
    mapKit();
    fake.db.kit_items.find(i => i.id === LINE_CLEAR).ref_unit_price = 189.99;
    // LINE_TAPE deliberately has none.

    const res = await request(storeApp()).get(`${S}/${KIT}/preview?location_id=${LOC}`);
    assert.equal(res.body.total_cost, 7);
    assert.equal(res.body.reference_total, null,
        'a partial reference compared against a full total is worse than none');
});

test('a category-locked location blocks a kit containing other categories', async () => {
    reset();
    mapKit();
    const res = await request(storeApp()).get(`${S}/${KIT}/preview?location_id=${EQUIP_LOC}`);
    assert.equal(res.body.blocked, true);
    assert.match(res.body.blocked_reason, /does not stock/i);
});

test('a multiplier out of range is refused', async () => {
    reset();
    mapKit();
    const res = await request(storeApp()).get(`${S}/${KIT}/preview?location_id=${LOC}&multiplier=1000`);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /cannot exceed/i);
});

// ==================================================================
// CONSUME
// ==================================================================

test('consuming a kit writes one movement per line, all against the job', async () => {
    reset();
    mapKit();

    const res = await request(storeApp()).post(`${S}/${KIT}/consume`).send({
        location_id: LOC, job_ref: 'RO-1234', actor_label: 'Sam'
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.consumption.line_count, 2);
    assert.equal(res.body.consumption.total_cost, 7);

    const movements = fake.db.stock_movements;
    assert.equal(movements.length, 2);
    assert.ok(movements.every(m => m.job_ref === 'RO-1234'));
    assert.ok(movements.every(m => m.movement_type === 'consume'));
    assert.ok(movements.every(m => m.source_doc_type === 'kit_consume'));
    assert.equal(new Set(movements.map(m => m.source_doc_id)).size, 1, 'all lines share one header');
    assert.ok(movements.every(m => m.actor_label === 'Sam'));
});

test('on-hand drops by exactly the kit quantities', async () => {
    reset();
    mapKit();
    await request(storeApp()).post(`${S}/${KIT}/consume`).send({
        location_id: LOC, job_ref: 'RO-1', actor_label: 'Sam'
    });

    const clear = fake.db.inventory_levels.find(l => l.product_id === CLEAR && l.location_id === LOC);
    const tape  = fake.db.inventory_levels.find(l => l.product_id === TAPE && l.location_id === LOC);
    assert.equal(clear.on_hand, 4.98);
    assert.equal(tape.on_hand, 19.7);
});

test('a repair order number is required', async () => {
    reset();
    mapKit();
    const res = await request(storeApp()).post(`${S}/${KIT}/consume`).send({
        location_id: LOC, actor_label: 'Sam'
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /repair order/i);
    assert.equal(fake.db.stock_movements.length, 0);
});

test('a name is required so the movement can be attributed', async () => {
    reset();
    mapKit();
    const res = await request(storeApp()).post(`${S}/${KIT}/consume`).send({
        location_id: LOC, job_ref: 'RO-1'
    });
    assert.equal(res.status, 400);
    assert.equal(fake.db.stock_movements.length, 0);
});

test('an unmapped kit refuses the consume outright and writes nothing', async () => {
    reset();
    const res = await request(storeApp()).post(`${S}/${KIT}/consume`).send({
        location_id: LOC, job_ref: 'RO-1', actor_label: 'Sam'
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.unresolved.length, 3);
    assert.equal(fake.db.stock_movements.length, 0);
    assert.equal(fake.db.kit_consumptions.length, 0);
});

test('insufficient stock refuses the whole kit — no line is applied', async () => {
    reset();
    mapKit();
    fake.db.inventory_levels.find(l => l.product_id === CLEAR).on_hand = 0;

    const res = await request(storeApp()).post(`${S}/${KIT}/consume`).send({
        location_id: LOC, job_ref: 'RO-1', actor_label: 'Sam'
    });

    assert.equal(res.status, 409);
    assert.equal(fake.db.stock_movements.length, 0, 'the tape must not be expensed either');
    assert.equal(fake.db.kit_consumptions.length, 0);
    // The tape was fine; it is the kit that failed, so its level is untouched.
    assert.equal(fake.db.inventory_levels.find(l => l.product_id === TAPE).on_hand, 20);
});

test('allow_negative lets a shop expense past zero when it has opted in', async () => {
    reset({ settings: { allow_negative: true } });
    mapKit();
    fake.db.inventory_levels.find(l => l.product_id === CLEAR).on_hand = 0;

    const res = await request(storeApp()).post(`${S}/${KIT}/consume`).send({
        location_id: LOC, job_ref: 'RO-1', actor_label: 'Sam'
    });
    assert.equal(res.status, 201);
    assert.equal(fake.db.inventory_levels.find(l => l.product_id === CLEAR).on_hand, -0.02);
});

test('a per-job override changes this job only, never the kit', async () => {
    reset();
    mapKit();

    const res = await request(storeApp()).post(`${S}/${KIT}/consume`).send({
        location_id: LOC, job_ref: 'RO-9', actor_label: 'Sam',
        lines: [{ kit_item_id: LINE_CLEAR, quantity: 0.5 }]
    });

    assert.equal(res.status, 201);
    const clearMovement = fake.db.stock_movements.find(m => m.product_id === CLEAR);
    assert.equal(Number(clearMovement.qty_change), -0.5);
    // The kit definition is untouched.
    assert.equal(fake.db.kit_items.find(i => i.id === LINE_CLEAR).quantity, 0.02);
});

test('a line can be skipped for one job', async () => {
    reset();
    mapKit();
    const res = await request(storeApp()).post(`${S}/${KIT}/consume`).send({
        location_id: LOC, job_ref: 'RO-9', actor_label: 'Sam',
        lines: [{ kit_item_id: LINE_TAPE, skip: true }]
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.consumption.line_count, 1);
    assert.equal(fake.db.stock_movements.length, 1);
});

test('skipping every line is refused rather than writing an empty job', async () => {
    reset();
    mapKit();
    const res = await request(storeApp()).post(`${S}/${KIT}/consume`).send({
        location_id: LOC, job_ref: 'RO-9', actor_label: 'Sam',
        lines: [{ kit_item_id: LINE_CLEAR, skip: true }, { kit_item_id: LINE_TAPE, skip: true }]
    });
    assert.equal(res.status, 400);
    assert.equal(fake.db.kit_consumptions.length, 0);
});

test('another company\'s kit cannot be consumed', async () => {
    reset();
    const res = await request(storeApp()).post(`${S}/${FOREIGN_KIT}/consume`).send({
        location_id: LOC, job_ref: 'RO-1', actor_label: 'Sam'
    });
    assert.equal(res.status, 404);
    assert.equal(fake.db.stock_movements.length, 0);
});

test('a kit cannot be consumed at another company\'s location', async () => {
    reset();
    mapKit();
    const res = await request(storeApp()).post(`${S}/${KIT}/consume`).send({
        location_id: '44444444-4444-4444-8444-444444444444', job_ref: 'RO-1', actor_label: 'Sam'
    });
    assert.equal(res.status, 400);
    assert.equal(fake.db.stock_movements.length, 0);
});

test('a mapping pointing at another company\'s product does not resolve', async () => {
    reset();
    // A mapping row that should never exist — the admin route refuses to create
    // one. If it did exist, the tenancy filter on the product read must catch it.
    fake.db.kit_product_map.push(
        { id: 'bad', company_id: CO, kit_item_id: LINE_CLEAR, product_id: OTHER_PRODUCT, is_excluded: false }
    );
    const res = await request(storeApp()).get(`${S}/${KIT}/preview?location_id=${LOC}`);
    assert.ok(res.body.unresolved.some(u => u.kit_item_id === LINE_CLEAR));
});

test('the module is refused when inventory is off for the company', async () => {
    reset({ settings: { enabled: false } });
    const res = await request(storeApp()).get(S);
    assert.equal(res.status, 403);
});

// ==================================================================
// HISTORY
// ==================================================================

test('consumption history is filterable by job and carries the movements', async () => {
    reset();
    mapKit();
    await request(storeApp()).post(`${S}/${KIT}/consume`).send({
        location_id: LOC, job_ref: 'RO-777', actor_label: 'Sam'
    });
    await request(storeApp()).post(`${S}/${KIT}/consume`).send({
        location_id: LOC, job_ref: 'RO-888', actor_label: 'Sam'
    });

    const all = await request(storeApp()).get(`${S}/consumptions`);
    assert.equal(all.body.consumptions.length, 2);

    const one = await request(storeApp()).get(`${S}/consumptions?job_ref=RO-777`);
    assert.equal(one.body.consumptions.length, 1);

    const detail = await request(storeApp()).get(`${S}/consumptions/${one.body.consumptions[0].id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.movements.length, 2);
});

test('the kit name on a consumption is a snapshot, not a live reference', async () => {
    reset();
    mapKit();
    await request(storeApp()).post(`${S}/${KIT}/consume`).send({
        location_id: LOC, job_ref: 'RO-5', actor_label: 'Sam'
    });

    fake.db.repair_kits.find(k => k.id === KIT).name = 'Renamed later';

    const res = await request(storeApp()).get(`${S}/consumptions?job_ref=RO-5`);
    assert.equal(res.body.consumptions[0].kit_name, 'Door Skin');
});

// ==================================================================
// ADMIN: MAPPING
// ==================================================================

const A = `/api/admin/companies/${CO}/inventory/kits`;

test('the mapping screen offers candidates only for unresolved lines', async () => {
    reset();
    const res = await request(adminApp()).get(`${A}/${KIT}/mapping`);
    assert.equal(res.status, 200);
    assert.equal(res.body.unmapped, 3);

    const clearLine = res.body.lines.find(l => l.kit_sku === 'PRF611N');
    assert.equal(clearLine.suggestions[0].sku, 'PRF611N');
    assert.equal(clearLine.suggestions[0].confidence, 'exact');
});

test('a SKU with no plausible catalogue match offers nothing rather than a wrong guess', async () => {
    reset();
    const res = await request(adminApp()).get(`${A}/${KIT}/mapping`);
    const ghost = res.body.lines.find(l => l.kit_sku === 'FUS123EZ');
    assert.deepEqual(ghost.suggestions, []);
});

test('suggestions are never applied automatically', async () => {
    reset();
    await request(adminApp()).get(`${A}/${KIT}/mapping`);
    assert.equal(fake.db.kit_product_map.length, 0);
});

test('saving a mapping resolves the line', async () => {
    reset();
    const save = await request(adminApp()).put(`${A}/mapping/${LINE_CLEAR}`).send({ product_id: CLEAR });
    assert.equal(save.status, 200);

    const res = await request(adminApp()).get(`${A}/${KIT}/mapping`);
    assert.equal(res.body.lines.find(l => l.kit_sku === 'PRF611N').mapped_product.sku, 'PRF611N');
    assert.equal(res.body.unmapped, 2);
});

test('a mapping cannot point at another company\'s product', async () => {
    reset();
    const res = await request(adminApp()).put(`${A}/mapping/${LINE_CLEAR}`).send({ product_id: OTHER_PRODUCT });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /catalogue/i);
    assert.equal(fake.db.kit_product_map.length, 0);
});

test('a line can be excluded for a shop that does not use it', async () => {
    reset();
    const res = await request(adminApp()).put(`${A}/mapping/${LINE_GHOST}`).send({ is_excluded: true, note: 'We buy this elsewhere' });
    assert.equal(res.status, 200);
    assert.equal(res.body.mapping.is_excluded, true);
    assert.equal(res.body.mapping.product_id, null);
});

test('a quantity override is stored per company', async () => {
    reset();
    await request(adminApp()).put(`${A}/mapping/${LINE_CLEAR}`).send({ product_id: CLEAR, quantity: 0.05 });
    const res = await request(adminApp()).get(`${A}/${KIT}/mapping`);
    const line = res.body.lines.find(l => l.kit_sku === 'PRF611N');
    assert.equal(line.quantity_override, 0.05);
    assert.equal(line.effective_quantity, 0.05);
    // The master kit is unchanged for everyone else.
    assert.equal(fake.db.kit_items.find(i => i.id === LINE_CLEAR).quantity, 0.02);
});

test('a negative or zero override is refused', async () => {
    reset();
    for (const quantity of [0, -1]) {
        const res = await request(adminApp()).put(`${A}/mapping/${LINE_CLEAR}`).send({ product_id: CLEAR, quantity });
        assert.equal(res.status, 400);
    }
});

test('bulk mapping saves the good rows and reports the bad ones', async () => {
    reset();
    const res = await request(adminApp()).post(`${A}/mapping/bulk`).send({
        mappings: [
            { kit_item_id: LINE_CLEAR, product_id: CLEAR },
            { kit_item_id: LINE_TAPE,  product_id: OTHER_PRODUCT },     // wrong company
            { kit_item_id: LINE_GHOST, is_excluded: true }
        ]
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.saved, 2);
    assert.equal(res.body.rejected.length, 1);
    assert.match(res.body.rejected[0].error, /catalogue/i);
});

test('mapping another company\'s private kit line is not found', async () => {
    reset();
    fake.db.kit_items.push({
        id: 'cccccccc-1111-4111-8111-111111111111', kit_id: FOREIGN_KIT,
        sku: 'X', product_id: null, quantity: 1, sort_order: 1
    });
    const res = await request(adminApp())
        .put(`${A}/mapping/cccccccc-1111-4111-8111-111111111111`)
        .send({ product_id: CLEAR });
    assert.equal(res.status, 404);
});

// ==================================================================
// ADMIN: ACCESS AND COMPANY KITS
// ==================================================================

test('granting and revoking a master kit is reversible and keeps the mapping', async () => {
    reset();
    await request(adminApp()).put(`${A}/mapping/${LINE_CLEAR}`).send({ product_id: CLEAR });

    const off = await request(adminApp()).put(`${A}/${KIT}/access`).send({ enabled: false });
    assert.equal(off.status, 200);
    assert.equal((await request(storeApp()).get(S)).body.kits.length, 1);

    const on = await request(adminApp()).put(`${A}/${KIT}/access`).send({ enabled: true });
    assert.equal(on.status, 200);
    assert.equal(fake.db.kit_product_map.length, 1, 'mapping survives the round trip');
});

test('access cannot be granted on a kit that belongs to a company', async () => {
    reset();
    const res = await request(adminApp()).put(`${A}/${PRIVATE_KIT}/access`).send({ enabled: true });
    assert.equal(res.status, 400);
});

test('a company kit is created from its own catalogue', async () => {
    reset();
    const res = await request(adminApp()).post(A).send({
        name: 'Bumper prep',
        lines: [{ product_id: TAPE, quantity: 1.5 }, { product_id: CLEAR, quantity: 0.1 }]
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.kit.line_count, 2);
});

test('a company kit cannot include another company\'s product', async () => {
    reset();
    const before = fake.db.repair_kits.length;
    const res = await request(adminApp()).post(A).send({
        name: 'Sneaky', lines: [{ product_id: OTHER_PRODUCT, quantity: 1 }]
    });
    assert.equal(res.status, 400);
    assert.equal(fake.db.repair_kits.length, before, 'no orphan kit is left behind');
});

test('a CHC master kit cannot be deleted from a company screen', async () => {
    reset();
    const res = await request(adminApp()).delete(`${A}/${KIT}`);
    assert.equal(res.status, 403);
    assert.ok(fake.db.repair_kits.some(k => k.id === KIT));
});

test('a company kit can be deleted', async () => {
    reset();
    const res = await request(adminApp()).delete(`${A}/${PRIVATE_KIT}`);
    assert.equal(res.status, 200);
    assert.ok(!fake.db.repair_kits.some(k => k.id === PRIVATE_KIT));
});

// ==================================================================
// SUGGESTION RANKING (pure)
// ==================================================================

const CATALOGUE = [
    { id: '1', sku: 'PRF611N',  name: 'ProForm mixing tips', price: 1, category: 'Paint' },
    { id: '2', sku: 'MMM08852', name: '3M tape 08852',       price: 1, category: 'Masking' },
    { id: '3', sku: 'MMM08853', name: '3M tape 08853',       price: 1, category: 'Masking' },
    { id: '4', sku: 'PRF-611N', name: 'Punctuated duplicate', price: 1, category: 'Paint' },
    { id: '5', sku: 'ZZZ999',   name: 'Unrelated',            price: 1, category: 'Other' }
];

test('an exact part number ranks first and is labelled exact', () => {
    const out = kitsAdmin.suggestProducts('MMM08852', CATALOGUE);
    assert.equal(out[0].sku, 'MMM08852');
    assert.equal(out[0].confidence, 'exact');
});

test('punctuation in a part number does not hide a match', () => {
    const out = kitsAdmin.suggestProducts('PRF611N', CATALOGUE);
    assert.equal(out[0].confidence, 'exact');
    assert.ok(out.some(o => o.sku === 'PRF-611N'));
});

test('a same-vendor near miss is offered but never as exact', () => {
    const out = kitsAdmin.suggestProducts('MMM08854', CATALOGUE);
    assert.ok(out.length > 0);
    assert.ok(out.every(o => o.confidence !== 'exact'));
    assert.ok(out.every(o => o.why));
});

test('an unrelated SKU produces nothing rather than a low-confidence guess', () => {
    assert.deepEqual(kitsAdmin.suggestProducts('QQQ111', CATALOGUE), []);
});

test('every suggestion carries a reason a person can check', () => {
    for (const s of kitsAdmin.suggestProducts('MMM08852', CATALOGUE)) {
        assert.ok(typeof s.why === 'string' && s.why.length > 0);
    }
});

// ------------------------------------------------------------------
// Order attribution.
//
// Migration 025 added handled_by / handled_by_name / handled_at so the console
// can answer "who dealt with this order". The columns shipped, the route wrote
// to them, and nothing tested the write — so when the fake's column guard did
// not know about them, every status change 500'd and only a live demo found it.
// This is that missing test.
// ------------------------------------------------------------------

test('changing an order status records who did it', async () => {
    reset();
    // Seed our own order rather than lean on a fixture this file does not have.
    // The insert also runs the column guard, so it proves the shape twice.
    const { data: order } = await fake.from('orders').insert({
        company_id: CO, order_number: 'CHC-TEST-0001', company_name: 'Assured Collision',
        contact_name: 'Shop Manager', contact_email: 'shop@example.com',
        items: [{ sku: 'PRF611N', quantity: 1, unit_price: 200 }],
        subtotal: 200, tax: 26, total: 226, status: 'pending'
    }).select().single();
    const before = fake.db.orders.length;

    // Goes through the fake's own update path, which runs the column guard.
    // Poking fake.db directly would skip that check and prove nothing.
    await fake.from('orders')
        .update({
            status: 'confirmed',
            handled_by: 'admin-1',
            handled_by_name: 'Frank G',
            handled_at: new Date().toISOString()
        })
        .eq('id', order.id);

    const updated = fake.db.orders.find(o => o.id === order.id);
    assert.equal(updated.handled_by_name, 'Frank G');
    assert.equal(updated.handled_by, 'admin-1');
    assert.ok(updated.handled_at, 'handled_at must be stamped');
    assert.equal(fake.db.orders.length, before, 'updating must not add a row');
});

test('the fake knows every column migration 025 added to orders', () => {
    // Reads the guard directly: if a migration adds an orders column and this
    // list is not updated in the same change, routes writing it fail only at
    // runtime. Naming them here makes that a test failure instead.
    const { KNOWN_COLUMNS } = require('./helpers/fake-supabase');
    assert.ok(KNOWN_COLUMNS && KNOWN_COLUMNS.orders, 'KNOWN_COLUMNS.orders must be exported');
    for (const col of ['handled_by', 'handled_by_name', 'handled_at']) {
        assert.ok(KNOWN_COLUMNS.orders.has(col), `orders.${col} missing from KNOWN_COLUMNS`);
    }
});
