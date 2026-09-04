/**
 * tests/inventory-phase45.test.js
 *
 * Phase 4 and 5: the Code 128 encoder, cycle-count sessions, inter-location
 * transfers, and the analytics period vocabulary.
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const bc = require('../utils/barcode-128');
const { createFakeSupabase } = require('./helpers/fake-supabase');

// ==================================================================
// CODE 128
// ==================================================================

test('the symbol table is structurally valid', () => {
    assert.equal(bc.PATTERNS.length, 107);
    assert.equal(new Set(bc.PATTERNS).size, 107, 'every symbol must be distinct');
    bc.PATTERNS.forEach((p, i) => {
        const modules = p.split('').reduce((a, d) => a + Number(d), 0);
        // Every Code 128 symbol is 11 modules over 6 elements; the stop pattern
        // is the sole exception at 13 over 7.
        assert.equal(modules, i === 106 ? 13 : 11, `symbol ${i} module count`);
        assert.equal(p.length, i === 106 ? 7 : 6, `symbol ${i} element count`);
    });
});

test('Set B encodes text with the right checksum', () => {
    // 'CHC': start-B(104), C(35), H(40), C(35).
    // Checksum = (104 + 35*1 + 40*2 + 35*3) mod 103 = 324 mod 103 = 15.
    assert.deepEqual(bc.encode('CHC'), [104, 35, 40, 35, 15, 106]);
});

test('Set C packs digit pairs and checksums correctly', () => {
    // start-C(105), 12, 34, 56, 78.
    // Checksum = (105 + 12 + 68 + 168 + 312) mod 103 = 665 mod 103 = 47.
    assert.deepEqual(bc.encode('12345678'), [105, 12, 34, 56, 78, 47, 106]);
});

test('Set C is roughly half the width of Set B for long digit strings', () => {
    const numeric = bc.encode('12345678901234');
    const alpha = bc.encode('ABCDEFGHIJKLMN');
    assert.ok(numeric.length < alpha.length,
        `expected Set C to be denser: ${numeric.length} vs ${alpha.length}`);
});

test('a mixed string switches sets and still round-trips the payload', () => {
    const values = bc.encode('RAI-2PCPSL');
    assert.equal(values[0], 104, 'a leading letter starts in Set B');
    assert.equal(values[values.length - 1], 106, 'ends with stop');
    // Every symbol value must be addressable in the table.
    values.forEach(v => assert.ok(v >= 0 && v < 107, `symbol ${v} out of range`));
});

test('every module width in a rendered symbol is 1-4', () => {
    const widths = bc.moduleWidths('RAI-920-121');
    assert.ok(widths.length > 0);
    widths.forEach(w => assert.ok(w >= 1 && w <= 4, `bad module width ${w}`));
});

test('non-ASCII is refused rather than silently mangled', () => {
    assert.throws(() => bc.encode('café'), /cannot encode/);
    assert.throws(() => bc.encode('tab\there'), /cannot encode/);
});

test('toSvg produces a self-contained SVG with a quiet zone', () => {
    const svg = bc.toSvg('RAI-2PCPSL');
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /<\/svg>$/);
    assert.match(svg, /RAI-2PCPSL/, 'the human-readable line should be present');
    assert.ok(svg.includes('<rect'), 'bars should be drawn');
    // First bar must start at the quiet zone, not at x=0.
    const firstBar = svg.match(/<rect x="([\d.]+)" y="0"/);
    assert.ok(Number(firstBar[1]) >= 20, 'a quiet zone of at least 10 modules is required to scan');
});

test('toSvg escapes a label that contains markup characters', () => {
    const svg = bc.toSvg('A<B>C');
    assert.ok(!svg.includes('<B>'), 'raw markup must not reach the SVG');
    assert.match(svg, /A&lt;B&gt;C/);
});

// ==================================================================
// ROUTES: COUNTS, TRANSFERS, ANALYTICS
// ==================================================================

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
        validEmails: (l) => l.filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim()))
    },
    [path.join(ROOT, 'utils/email.js')]: {
        sendOrderNotification: async () => {}, sendInvoiceReady: async () => {},
        sendOrderClosed: async () => {}, sendLowStockAlert: async () => ({ sent: true })
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

const COMPANY_ID  = '11111111-1111-4111-8111-111111111111';
const LOC_A       = '33333333-3333-4333-8333-333333333333';
const LOC_B       = '44444444-4444-4444-8444-444444444444';
const PRODUCT_ID  = '55555555-5555-4555-8555-555555555555';
const PRODUCT_2   = '66666666-6666-4666-8666-666666666666';

function reset(overrides = {}) {
    fake = createFakeSupabase({
        companies: [{
            id: COMPANY_ID, name: 'Assured Collision', slug: 'assured',
            settings: { inventory: { enabled: true, auto_draft: false, allow_negative: false, ...overrides } }
        }],
        company_locations: [
            { id: LOC_A, company_id: COMPANY_ID, name: 'Burlington', is_active: true, restrict_to_category: null },
            { id: LOC_B, company_id: COMPANY_ID, name: 'Oakville', is_active: true, restrict_to_category: null }
        ],
        products: [
            { id: PRODUCT_ID, company_id: COMPANY_ID, sku: '2PCPSL', name: 'Two piece Paint Suit Large',
              brand: 'PPG', category: 'Masks/Suits', price: 84.48, is_active: true },
            { id: PRODUCT_2, company_id: COMPANY_ID, sku: '920-121', name: 'Quart Can w/Lid',
              brand: 'PPG', category: 'Colour', price: 180.75, is_active: true }
        ],
        product_barcodes: [
            { id: 'bc-1', product_id: PRODUCT_ID, barcode: '0051131020474' },
            { id: 'bc-2', product_id: PRODUCT_2, barcode: 'RAI-920-121' }
        ]
    });
    authCompany = { id: COMPANY_ID, name: 'Assured Collision', slug: 'assured' };
}

function app() {
    const a = express();
    a.use(express.json());
    a.use('/api/store/:slug/inventory', inventoryStore);
    return a;
}

const S = '/api/store/assured/inventory';

function receive(productId, qty, locationId = LOC_A) {
    return request(app()).post(`${S}/movements`).send({
        location_id: locationId, product_id: productId,
        movement_type: 'receive', quantity: qty, actor_label: 'Sam'
    });
}

async function openCount(body = {}) {
    const res = await request(app()).post(`${S}/counts`)
        .send({ location_id: LOC_A, actor_label: 'Dana', ...body });
    return res;
}

// ---------- cycle counts ----------

test('a count can be opened and resumed', async () => {
    reset();
    const res = await openCount();
    assert.equal(res.status, 201);
    assert.equal(res.body.session.status, 'open');
    assert.equal(res.body.session.opened_by, 'Dana');

    const list = await request(app()).get(`${S}/counts?location_id=${LOC_A}&status=open`);
    assert.equal(list.body.sessions.length, 1);
});

test('only one count can be open per location', async () => {
    reset();
    await openCount();
    const second = await openCount();
    assert.equal(second.status, 409);
    assert.match(second.body.error, /already has a count open/);
});

test('opening a count requires a name', async () => {
    reset();
    const res = await request(app()).post(`${S}/counts`).send({ location_id: LOC_A });
    assert.equal(res.status, 400);
});

test('a scoped count needs its scope value', async () => {
    reset();
    const res = await openCount({ scope_type: 'category' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /category is required/i);
});

test('counting records the variance without touching stock', async () => {
    reset();
    await receive(PRODUCT_ID, 10);
    const session = (await openCount()).body.session;

    const line = await request(app()).post(`${S}/counts/${session.id}/lines`).send({
        product_id: PRODUCT_ID, counted_qty: 8, actor_label: 'Dana'
    });
    assert.equal(line.status, 201);
    assert.equal(line.body.expected_qty, 10);
    assert.equal(line.body.variance, -2);

    // Crucially, on-hand has not moved yet.
    assert.equal(Number(fake.db.inventory_levels[0].on_hand), 10);
    assert.equal(fake.db.stock_movements.length, 1, 'only the original receive');
});

test('re-counting an item replaces its line rather than adding a second', async () => {
    reset();
    await receive(PRODUCT_ID, 10);
    const session = (await openCount()).body.session;

    await request(app()).post(`${S}/counts/${session.id}/lines`)
        .send({ product_id: PRODUCT_ID, counted_qty: 8, actor_label: 'Dana' });
    await request(app()).post(`${S}/counts/${session.id}/lines`)
        .send({ product_id: PRODUCT_ID, counted_qty: 9, actor_label: 'Dana' });

    assert.equal(fake.db.inventory_count_lines.length, 1);
    assert.equal(Number(fake.db.inventory_count_lines[0].counted_qty), 9);
});

test('a category-scoped count refuses items outside it', async () => {
    reset();
    const session = (await openCount({ scope_type: 'category', scope_value: 'Colour' })).body.session;
    const res = await request(app()).post(`${S}/counts/${session.id}/lines`)
        .send({ product_id: PRODUCT_ID, counted_qty: 1, actor_label: 'Dana' });   // Masks/Suits
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Colour only/);
});

test('committing posts one movement per genuine variance', async () => {
    reset();
    await receive(PRODUCT_ID, 10);
    await receive(PRODUCT_2, 5);
    const session = (await openCount()).body.session;

    await request(app()).post(`${S}/counts/${session.id}/lines`)
        .send({ product_id: PRODUCT_ID, counted_qty: 8, actor_label: 'Dana' });   // -2
    await request(app()).post(`${S}/counts/${session.id}/lines`)
        .send({ product_id: PRODUCT_2, counted_qty: 5, actor_label: 'Dana' });    // matches

    const res = await request(app()).post(`${S}/counts/${session.id}/commit`)
        .send({ actor_label: 'Dana' });

    assert.equal(res.status, 200);
    assert.equal(res.body.adjusted, 1, 'only the item that actually differed');
    assert.equal(res.body.unchanged, 1);

    const counts = fake.db.stock_movements.filter(m => m.movement_type === 'count');
    assert.equal(counts.length, 1);
    assert.equal(Number(counts[0].qty_change), -2);
    assert.equal(Number(fake.db.inventory_levels.find(l => l.product_id === PRODUCT_ID).on_hand), 8);
    assert.equal(fake.db.inventory_count_sessions[0].status, 'committed');
});

test('a commit measures against on-hand now, not at count time', async () => {
    reset();
    await receive(PRODUCT_ID, 10);
    const session = (await openCount()).body.session;
    await request(app()).post(`${S}/counts/${session.id}/lines`)
        .send({ product_id: PRODUCT_ID, counted_qty: 10, actor_label: 'Dana' });

    // A technician legitimately uses 3 while the count is still open.
    await request(app()).post(`${S}/movements`).send({
        location_id: LOC_A, product_id: PRODUCT_ID, movement_type: 'consume',
        quantity: 3, actor_label: 'Sam'
    });

    await request(app()).post(`${S}/counts/${session.id}/commit`).send({ actor_label: 'Dana' });

    // The count said 10 and on-hand is now 7, so the commit puts it back to 10.
    assert.equal(Number(fake.db.inventory_levels[0].on_hand), 10);
    const counts = fake.db.stock_movements.filter(m => m.movement_type === 'count');
    assert.equal(Number(counts[0].qty_change), 3);
});

test('an empty count cannot be committed', async () => {
    reset();
    const session = (await openCount()).body.session;
    const res = await request(app()).post(`${S}/counts/${session.id}/commit`).send({ actor_label: 'Dana' });
    assert.equal(res.status, 400);
});

test('cancelling needs a reason and changes no stock', async () => {
    reset();
    await receive(PRODUCT_ID, 10);
    const session = (await openCount()).body.session;
    await request(app()).post(`${S}/counts/${session.id}/lines`)
        .send({ product_id: PRODUCT_ID, counted_qty: 2, actor_label: 'Dana' });

    const noReason = await request(app()).post(`${S}/counts/${session.id}/cancel`)
        .send({ actor_label: 'Dana' });
    assert.equal(noReason.status, 400);

    const ok = await request(app()).post(`${S}/counts/${session.id}/cancel`)
        .send({ actor_label: 'Dana', reason: 'Wrong shelf' });
    assert.equal(ok.status, 200);
    assert.equal(fake.db.inventory_count_sessions[0].status, 'cancelled');
    assert.equal(Number(fake.db.inventory_levels[0].on_hand), 10, 'stock must be untouched');
});

test('a committed count cannot be committed again', async () => {
    reset();
    await receive(PRODUCT_ID, 10);
    const session = (await openCount()).body.session;
    await request(app()).post(`${S}/counts/${session.id}/lines`)
        .send({ product_id: PRODUCT_ID, counted_qty: 8, actor_label: 'Dana' });
    await request(app()).post(`${S}/counts/${session.id}/commit`).send({ actor_label: 'Dana' });

    const again = await request(app()).post(`${S}/counts/${session.id}/commit`).send({ actor_label: 'Dana' });
    assert.equal(again.status, 404);
    assert.equal(fake.db.stock_movements.filter(m => m.movement_type === 'count').length, 1);
});

// ---------- transfers ----------

test('a transfer writes both legs and reconciles', async () => {
    reset();
    await receive(PRODUCT_ID, 10, LOC_A);

    const res = await request(app()).post(`${S}/transfers`).send({
        from_location_id: LOC_A, to_location_id: LOC_B,
        product_id: PRODUCT_ID, quantity: 4, actor_label: 'Sam'
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.from_on_hand, 6);
    assert.equal(res.body.to_on_hand, 4);

    const out = fake.db.stock_movements.find(m => m.movement_type === 'transfer_out');
    const inn = fake.db.stock_movements.find(m => m.movement_type === 'transfer_in');
    assert.equal(Number(out.qty_change), -4);
    assert.equal(Number(inn.qty_change), 4);
    assert.equal(Number(out.qty_change) + Number(inn.qty_change), 0, 'the pair must net to zero');
    assert.equal(fake.db.inventory_transfers.length, 1);
});

test('a transfer cannot exceed what the source holds', async () => {
    reset();
    await receive(PRODUCT_ID, 2, LOC_A);
    const res = await request(app()).post(`${S}/transfers`).send({
        from_location_id: LOC_A, to_location_id: LOC_B,
        product_id: PRODUCT_ID, quantity: 5, actor_label: 'Sam'
    });
    assert.equal(res.status, 409);
    assert.equal(fake.db.stock_movements.filter(m => m.movement_type.startsWith('transfer')).length, 0);
});

test('a transfer to the same location is refused', async () => {
    reset();
    await receive(PRODUCT_ID, 10, LOC_A);
    const res = await request(app()).post(`${S}/transfers`).send({
        from_location_id: LOC_A, to_location_id: LOC_A,
        product_id: PRODUCT_ID, quantity: 1, actor_label: 'Sam'
    });
    assert.equal(res.status, 400);
});

test('a transfer respects the destination category lock', async () => {
    reset();
    fake.db.company_locations[1].restrict_to_category = 'Equip/Filter/Booth';
    await receive(PRODUCT_ID, 10, LOC_A);
    const res = await request(app()).post(`${S}/transfers`).send({
        from_location_id: LOC_A, to_location_id: LOC_B,
        product_id: PRODUCT_ID, quantity: 1, actor_label: 'Sam'
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /only stocks/);
});

test('a transfer needs a name and a positive quantity', async () => {
    reset();
    await receive(PRODUCT_ID, 10, LOC_A);
    const base = { from_location_id: LOC_A, to_location_id: LOC_B, product_id: PRODUCT_ID };

    assert.equal((await request(app()).post(`${S}/transfers`).send({ ...base, quantity: 1 })).status, 400);
    assert.equal((await request(app()).post(`${S}/transfers`).send({ ...base, quantity: 0, actor_label: 'Sam' })).status, 400);
    assert.equal((await request(app()).post(`${S}/transfers`).send({ ...base, quantity: -3, actor_label: 'Sam' })).status, 400);
});

test('another company cannot transfer using this company\'s locations', async () => {
    reset();
    await receive(PRODUCT_ID, 10, LOC_A);
    authCompany = { id: '99999999-9999-4999-8999-999999999999', name: 'Someone else', slug: 'other' };
    fake.db.companies.push({
        id: authCompany.id, name: 'Someone else', slug: 'other',
        settings: { inventory: { enabled: true } }
    });

    const res = await request(app()).post('/api/store/other/inventory/transfers').send({
        from_location_id: LOC_A, to_location_id: LOC_B,
        product_id: PRODUCT_ID, quantity: 1, actor_label: 'Mallory'
    });
    assert.equal(res.status, 400);
    assert.equal(fake.db.inventory_transfers.length, 0);
});

// ---------- transfers: the scan basket posts here ----------

test('a batch of staged transfers writes a two-legged transfer per line', async () => {
    reset();
    await receive(PRODUCT_ID, 10, LOC_A);
    await receive(PRODUCT_2, 5, LOC_A);

    const res = await request(app()).post(`${S}/transfers/bulk`).send({
        from_location_id: LOC_A, to_location_id: LOC_B, actor_label: 'Sam',
        transfers: [
            { product_id: PRODUCT_ID, quantity: 3, scanned_barcode: '0051131020474' },
            { product_id: PRODUCT_2, quantity: 2 }
        ]
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.applied, 2);
    assert.equal(res.body.failed, 0);
    assert.equal(res.body.results[0].ok, true);
    assert.equal(res.body.results[0].to_on_hand, 3);
    assert.equal(res.body.results[1].to_on_hand, 2);
    assert.equal(fake.db.inventory_transfers.length, 2);
    assert.equal(fake.db.stock_movements.filter(m => m.movement_type === 'transfer_out').length, 2);
});

test('scanning the same item twice into one batch stages it as one line client-side, but the batch endpoint itself just sums whatever it is sent', async () => {
    reset();
    await receive(PRODUCT_ID, 10, LOC_A);

    // The basket UI collapses repeat scans into a single incremented line
    // before posting; the endpoint has no opinion about that and simply
    // applies each line it is given.
    const res = await request(app()).post(`${S}/transfers/bulk`).send({
        from_location_id: LOC_A, to_location_id: LOC_B, actor_label: 'Sam',
        transfers: [{ product_id: PRODUCT_ID, quantity: 2 }]
    });
    assert.equal(res.body.results[0].to_on_hand, 2);
});

test('one shortfall in a batch fails only that line and leaves the rest posted', async () => {
    reset();
    await receive(PRODUCT_ID, 2, LOC_A);
    await receive(PRODUCT_2, 5, LOC_A);

    const res = await request(app()).post(`${S}/transfers/bulk`).send({
        from_location_id: LOC_A, to_location_id: LOC_B, actor_label: 'Sam',
        transfers: [
            { product_id: PRODUCT_ID, quantity: 5 },   // only 2 on hand
            { product_id: PRODUCT_2, quantity: 1 }
        ]
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.applied, 1);
    assert.equal(res.body.failed, 1);
    assert.equal(res.body.results[0].ok, false);
    assert.match(res.body.results[0].error, /Only 2 on hand/);
    assert.equal(res.body.results[1].ok, true);
    assert.equal(fake.db.inventory_transfers.length, 1);
});

test('a transfer batch needs a name, a from, and a to before touching any line', async () => {
    reset();
    await receive(PRODUCT_ID, 10, LOC_A);
    const line = { product_id: PRODUCT_ID, quantity: 1 };

    assert.equal((await request(app()).post(`${S}/transfers/bulk`)
        .send({ from_location_id: LOC_A, to_location_id: LOC_B, transfers: [line] })).status, 400);
    assert.equal((await request(app()).post(`${S}/transfers/bulk`)
        .send({ from_location_id: LOC_A, to_location_id: LOC_A, actor_label: 'Sam', transfers: [line] })).status, 400);
    assert.equal((await request(app()).post(`${S}/transfers/bulk`)
        .send({ from_location_id: LOC_A, to_location_id: LOC_B, actor_label: 'Sam', transfers: [] })).status, 400);
    assert.equal(fake.db.inventory_transfers.length, 0);
});

test('another company cannot batch-transfer using this company\'s locations', async () => {
    reset();
    await receive(PRODUCT_ID, 10, LOC_A);
    authCompany = { id: '99999999-9999-4999-8999-999999999999', name: 'Someone else', slug: 'other' };
    fake.db.companies.push({
        id: authCompany.id, name: 'Someone else', slug: 'other',
        settings: { inventory: { enabled: true } }
    });

    const res = await request(app()).post('/api/store/other/inventory/transfers/bulk').send({
        from_location_id: LOC_A, to_location_id: LOC_B, actor_label: 'Mallory',
        transfers: [{ product_id: PRODUCT_ID, quantity: 1 }]
    });
    assert.equal(res.status, 400);
    assert.equal(fake.db.inventory_transfers.length, 0);
});

// ---------- analytics ----------

const { periodRange } = require('../routes/inventory-analytics');

test('named periods resolve to a sane range', () => {
    const month = periodRange({ period: 'this_month' });
    assert.ok(month.from && month.to);
    assert.ok(new Date(month.from) <= new Date(month.to));

    const all = periodRange({ period: 'all' });
    assert.equal(all.from, null);
    assert.equal(all.to, null);
    assert.equal(all.label, 'All time');

    const week = periodRange({ period: 'last_7' });
    const days = (new Date(week.to) - new Date(week.from)) / 864e5;
    assert.ok(days > 6.9 && days < 7.1, `expected ~7 days, got ${days}`);
});

test('a custom period parses both ends inclusively', () => {
    const r = periodRange({ period: 'custom', from: '2026-01-01', to: '2026-01-31' });
    assert.ok(r.from.startsWith('2026-01-01') || r.from.startsWith('2025-12-31'));  // tz-dependent
    assert.ok(new Date(r.to) > new Date(r.from));
});

test('a malformed custom period yields nulls rather than an invalid date', () => {
    const r = periodRange({ period: 'custom', from: 'garbage', to: '' });
    assert.equal(r.from, null);
    assert.equal(r.to, null);
});

test('analytics endpoints are behind the same feature gate', async () => {
    reset();
    fake.db.companies[0].settings = {};
    const res = await request(app()).get(`${S}/analytics/summary?period=last_30`);
    assert.equal(res.status, 403);
});

test('the consumption summary shapes an empty period without failing', async () => {
    reset();
    const res = await request(app()).get(`${S}/analytics/summary?period=last_30&location_id=${LOC_A}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.totals.units_used, 0);
    assert.deepEqual(res.body.series, []);
});

// ---------- benchmark (anonymous cross-shop usage & pricing) ----------

const ME       = COMPANY_ID;
const PEER_A   = 'cccccca1-1111-4111-8111-111111111111';
const PEER_B   = 'cccccca2-2222-4222-8222-222222222222';
const PEER_C   = 'cccccca3-3333-4333-8333-333333333333';
const PEER_D   = 'cccccca4-4444-4444-8444-444444444444'; // inactive company
const PROD_ME  = 'ddddddd0-0000-4000-8000-000000000000';
const PROD_A   = 'ddddddd1-1111-4111-8111-111111111111';
const PROD_B   = 'ddddddd2-2222-4222-8222-222222222222';
const PROD_C   = 'ddddddd3-3333-4333-8333-333333333333';
const PROD_D   = 'ddddddd4-4444-4444-8444-444444444444';

/**
 * Seeds ME plus a configurable set of peer companies, each holding the same
 * physical part under its own SKU (resolved to one master identity via
 * v_product_master), each with its own consumption row for the period.
 */
function seedBenchmark({ peers = [], myUsage = null } = {}) {
    const companies = [
        { id: ME, name: 'Assured Collision', slug: 'assured', is_active: true, settings: { inventory: { enabled: true } } },
        ...peers.map(p => ({ id: p.id, name: `Peer ${p.id}`, slug: p.id, is_active: p.is_active !== false, settings: {} }))
    ];
    const consumption = [];
    if (myUsage) consumption.push({ company_id: ME, product_id: PROD_ME, units_used: myUsage.units, value_used: myUsage.value, day: RECENT_DAY });
    for (const p of peers) {
        consumption.push({ company_id: p.id, product_id: p.product_id, units_used: p.units, value_used: p.value, day: RECENT_DAY });
    }
    const master = [
        { product_id: PROD_ME, master_sku: 'CHC-8001', master_name: 'Test Basecoat', match_type: 'exact' },
        ...peers.map(p => ({ product_id: p.product_id, master_sku: 'CHC-8001', master_name: 'Test Basecoat', match_type: 'alias' }))
    ];
    fake = createFakeSupabase({
        companies,
        company_locations: [{ id: LOC_A, company_id: ME, name: 'Burlington', is_active: true }],
        inventory_consumption_daily: consumption,
        v_product_master: master
    });
    authCompany = { id: ME, name: 'Assured Collision', slug: 'assured' };
}
const RECENT_DAY = new Date().toISOString().slice(0, 10);

test('a part bought by fewer than three other shops is never benchmarked', async () => {
    seedBenchmark({
        myUsage: { units: 10, value: 1000 },
        peers: [
            { id: PEER_A, product_id: PROD_A, units: 20, value: 1800 },
            { id: PEER_B, product_id: PROD_B, units: 30, value: 2700 }
        ]
    });
    const res = await request(app()).get(`${S}/analytics/benchmark?period=all`);
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 0, 'two peers is below the floor — nothing should be reported');
});

test('a part bought by at least three other shops reports an anonymous average', async () => {
    seedBenchmark({
        myUsage: { units: 10, value: 1000 },   // $100/unit
        peers: [
            { id: PEER_A, product_id: PROD_A, units: 20, value: 1800 },  // $90/unit
            { id: PEER_B, product_id: PROD_B, units: 30, value: 2700 },  // $90/unit
            { id: PEER_C, product_id: PROD_C, units: 10, value: 1200 }   // $120/unit
        ]
    });
    const res = await request(app()).get(`${S}/analytics/benchmark?period=all`);
    assert.equal(res.status, 200);
    assert.equal(res.body.min_peer_companies, 3);

    const item = res.body.items.find(i => i.sku === 'CHC-8001');
    assert.ok(item, 'three shops sharing one master part must be reported');
    assert.equal(item.peer_company_count, 3);
    assert.equal(item.your_units, 10);
    assert.equal(item.your_avg_price, 100);
    // Average of each peer's own average price: (90 + 90 + 120) / 3 = 100.
    assert.equal(item.peer_avg_price, 100);
    // Average of peer units: (20 + 30 + 10) / 3 = 20.
    assert.equal(item.peer_avg_units, 20);
    assert.equal(item.price_vs_peer_pct, 0);

    // Nothing identifying any one peer should ever reach the response.
    const raw = JSON.stringify(res.body);
    assert.ok(!raw.includes(PEER_A) && !raw.includes(PEER_B) && !raw.includes(PEER_C),
        'no peer company id may appear in a benchmark response');
});

test('a shop that has never bought the part still sees the peer benchmark', async () => {
    seedBenchmark({
        myUsage: null,
        peers: [
            { id: PEER_A, product_id: PROD_A, units: 20, value: 1800 },
            { id: PEER_B, product_id: PROD_B, units: 30, value: 2700 },
            { id: PEER_C, product_id: PROD_C, units: 10, value: 1200 }
        ]
    });
    const res = await request(app()).get(`${S}/analytics/benchmark?period=all`);
    const item = res.body.items.find(i => i.sku === 'CHC-8001');
    assert.ok(item);
    assert.equal(item.your_units, 0);
    assert.equal(item.your_avg_price, null, 'no purchase history means no price of our own to compare');
    assert.equal(item.peer_avg_price, 100);
});

test('an inactive peer counts toward neither the floor nor the average', async () => {
    seedBenchmark({
        myUsage: { units: 10, value: 1000 },
        peers: [
            { id: PEER_A, product_id: PROD_A, units: 20, value: 1800 },
            { id: PEER_B, product_id: PROD_B, units: 30, value: 2700 },
            { id: PEER_D, product_id: PROD_D, units: 999, value: 1, is_active: false } // wild outlier, but closed
        ]
    });
    const res = await request(app()).get(`${S}/analytics/benchmark?period=all`);
    // Only two ACTIVE peers remain, which is below the floor.
    assert.equal(res.body.items.length, 0);
});

test('benchmark is behind the same feature gate as the rest of inventory', async () => {
    seedBenchmark({ myUsage: { units: 1, value: 100 }, peers: [
        { id: PEER_A, product_id: PROD_A, units: 1, value: 100 },
        { id: PEER_B, product_id: PROD_B, units: 1, value: 100 },
        { id: PEER_C, product_id: PROD_C, units: 1, value: 100 }
    ] });
    fake.db.companies.find(c => c.id === ME).settings = {}; // inventory not enabled
    const res = await request(app()).get(`${S}/analytics/benchmark?period=all`);
    assert.equal(res.status, 403);
});

// ==================================================================
// INTERNAL LABEL CODES
// ==================================================================

const { internalCodeFor } = require('../routes/inventory-labels');

test('a clean part number becomes a clean internal code', () => {
    assert.equal(internalCodeFor('2PCPSL'), 'RAI-2PCPSL');
    assert.equal(internalCodeFor('920-121'), 'RAI-920-121');
    assert.equal(internalCodeFor('SEM4P-15-014'), 'RAI-SEM4P-15-014');
    assert.equal(internalCodeFor('sem62213'), 'RAI-SEM62213');
});

test('two part numbers that differ only by a stripped character get different codes', () => {
    // The real CHC catalogue contains both of these. Collapsing them onto one
    // code would make the scan ambiguous forever.
    const a = internalCodeFor('GLO@750M-5G');
    const b = internalCodeFor('GLO750M-5G');
    assert.notEqual(a, b);
    assert.equal(b, 'RAI-GLO750M-5G');
    assert.match(a, /^RAI-GLO750M-5G-[0-9A-Z]{2}$/);
});

test('an internal code is reproducible from the part number alone', () => {
    // A label that falls off the shelf has to be regenerable, so no randomness.
    for (const sku of ['GLO@750M-5G', 'White T-Shirts', 'Gun Wash 18.9L', '2PCPSL']) {
        assert.equal(internalCodeFor(sku), internalCodeFor(sku));
    }
});

test('internal codes survive Code 128 encoding', () => {
    for (const sku of ['GLO@750M-5G', 'White T-Shirts', 'Gun Wash 18.9L', '920-121', 'MMM06652 - ROLL']) {
        const code = internalCodeFor(sku);
        assert.ok(code, `no code for ${sku}`);
        assert.doesNotThrow(() => bc.encode(code), `${code} is not encodable`);
        assert.ok(code.length <= 128);
    }
});

test('a part number with nothing usable in it yields no code', () => {
    assert.equal(internalCodeFor(''), null);
    assert.equal(internalCodeFor('   '), null);
    assert.equal(internalCodeFor('###'), null);
    assert.equal(internalCodeFor(null), null);
});

test('a very long part number is truncated but stays unique', () => {
    const long = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const code = internalCodeFor(long);
    assert.ok(code.length < long.length + 8);
    assert.notEqual(internalCodeFor(long), internalCodeFor(long + 'Z'));
});
