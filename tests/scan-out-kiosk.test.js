/**
 * tests/scan-out-kiosk.test.js
 *
 * The scan-out kiosk: a tablet with a secret link, no login, an optional
 * "scan your ID badge first" step, and a console panel to run it.
 *
 * What these protect:
 *   - the kiosk link is the only credential, is stored hashed, and a wrong,
 *     revoked or switched-off link gets nothing;
 *   - a kiosk can only resolve scans and post scan-outs, and never learns a
 *     price or a stock level;
 *   - scan-outs land in the ledger as `consume` with the right person, tablet
 *     and session, exactly once even when the tablet retries;
 *   - the ID-badge requirement can be switched off per company;
 *   - the console panel never touches how a company signs in to its store.
 *
 *   node --test tests/scan-out-kiosk.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const crypto = require('node:crypto');

const { createFakeSupabase } = require('./helpers/fake-supabase');

// ------------------------------------------------------------------
// Stubs, installed before the routes are required.
// ------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '..');
let fake = createFakeSupabase();

const supabaseProxy = new Proxy({}, {
    get: (_t, prop) => {
        const v = fake[prop];
        return typeof v === 'function' ? v.bind(fake) : v;
    }
});

const stubs = {
    [path.join(ROOT, 'utils/supabase.js')]: { supabaseAdmin: supabaseProxy },
    [path.join(ROOT, 'middleware/auth.js')]: {
        requireCompanyAuth: (req, res) => res.status(401).json({ error: 'Not authenticated.' }),
        requireAdminAuth: (req, res, next) => next(),
        requireSuperAdmin: (req, res, next) => next(),
        requireCompanyAccess: (req, res, next) => next()
    },
    [path.join(ROOT, 'utils/email.js')]: {
        sendOrderNotification: async () => {},
        sendInvoiceReady: async () => {},
        sendOrderClosed: async () => {},
        sendLowStockAlert: async () => {}
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
const kioskRouter = require('../routes/kiosk');
const adminRouter = require('../routes/scan-out-admin');
const so = require('../utils/scan-out');
const modules = require('../utils/modules');

// ------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------
const CO      = '11111111-1111-4111-8111-111111111111';
const OTHER   = '22222222-2222-4222-8222-222222222222';
const LOC     = '33333333-3333-4333-8333-333333333333';
const OTHER_LOC = '44444444-4444-4444-8444-444444444444';
const P_MASK  = '55555555-5555-4555-8555-555555555555';
const P_TAPE  = '66666666-6666-4666-8666-666666666666';
const P_OTHER = '77777777-7777-4777-8777-777777777777';
const P_DUP_A = '88888888-8888-4888-8888-888888888881';
const P_DUP_B = '88888888-8888-4888-8888-888888888882';
const BADGE_ID = '99999999-9999-4999-8999-999999999991';
const BADGE_OFF = '99999999-9999-4999-8999-999999999992';
const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01';

const TOKEN = so.newKioskToken();
const BADGE_CODE = 'ID-ALEX2345';
const OFF_CODE = 'ID-GONE2345';

function seed(scanOut = {}, invOverrides = {}) {
    return createFakeSupabase({
        companies: [
            { id: CO, name: 'Assured Collision', slug: 'assured', is_active: true,
              settings: {
                  inventory: { enabled: true, auto_draft: true, allow_negative: false, ...invOverrides },
                  scan_out: { enabled: true, require_badge: true, ...scanOut }
              } },
            { id: OTHER, name: 'Other Shop', slug: 'other', is_active: true, settings: {} }
        ],
        company_locations: [
            { id: LOC, company_id: CO, name: 'Burlington', is_active: true },
            { id: OTHER_LOC, company_id: OTHER, name: 'Elsewhere', is_active: true }
        ],
        products: [
            { id: P_MASK, company_id: CO, sku: 'MASK-1', name: 'Respirator mask', brand: 'PPG', price: 49.5, unit: 'ea', is_active: true },
            { id: P_TAPE, company_id: CO, sku: 'TAPE-18', name: 'Masking tape 18mm', brand: '3M', price: 3.2, unit: 'roll', is_active: true },
            { id: P_OTHER, company_id: OTHER, sku: 'OTHER-1', name: 'Someone else’s item', price: 1, is_active: true },
            { id: P_DUP_A, company_id: CO, sku: 'DUP-A', name: 'Twin A', is_active: true },
            { id: P_DUP_B, company_id: CO, sku: 'DUP-B', name: 'Twin B', is_active: true }
        ],
        product_barcodes: [
            { id: 'b1', product_id: P_MASK, barcode: '0051131020474', symbology: 'ean_13', is_primary: true },
            { id: 'b2', product_id: P_TAPE, barcode: 'RAI-TAPE-18', symbology: 'code_128', is_primary: true },
            { id: 'b3', product_id: P_DUP_A, barcode: 'SHARED-1', symbology: 'code_128', is_primary: true },
            { id: 'b4', product_id: P_DUP_B, barcode: 'SHARED-1', symbology: 'code_128', is_primary: false }
        ],
        inventory_levels: [
            { id: 'l1', company_id: CO, location_id: LOC, product_id: P_MASK, on_hand: 10, min_point: 4, max_point: 12, reorder_qty: 6, is_tracked: true },
            { id: 'l2', company_id: CO, location_id: LOC, product_id: P_TAPE, on_hand: 2, min_point: null, max_point: null, is_tracked: true }
        ],
        kiosk_devices: [
            { id: DEVICE_ID, company_id: CO, location_id: LOC, name: 'Paint room tablet',
              token_hash: so.hashKioskToken(TOKEN), token_hint: TOKEN.slice(-4), is_active: true }
        ],
        kiosk_badges: [
            { id: BADGE_ID, company_id: CO, name: 'Alex Painter', trade: 'painter', badge_code: BADGE_CODE, is_active: true },
            { id: BADGE_OFF, company_id: CO, name: 'Gone Person', trade: 'bodyman', badge_code: OFF_CODE, is_active: false }
        ]
    });
}

function kioskApp() {
    const a = express();
    a.use(express.json());
    a.use('/api/kiosk', kioskRouter);
    return a;
}

function adminApp() {
    const a = express();
    a.use(express.json());
    a.use((req, res, next) => { req.admin = { id: 'admin-1' }; next(); });
    a.use('/api/admin/companies/:companyId/inventory/scan-out', adminRouter);
    return a;
}

const get = (url, token = TOKEN) => request(kioskApp()).get(url).set('X-Kiosk-Token', token);
const post = (url, body, token = TOKEN) => request(kioskApp()).post(url).set('X-Kiosk-Token', token).send(body);
const A = `/api/admin/companies/${CO}/inventory/scan-out`;

function movements() { return fake.db.stock_movements; }
function onHand(productId) { return Number(fake.db.inventory_levels.find(l => l.product_id === productId).on_hand); }

// ==================================================================
// Rules (no database)
// ==================================================================
test('badge codes are prefixed, unambiguous and valid for the database check', () => {
    const seen = new Set();
    for (let i = 0; i < 500; i++) {
        const code = so.newBadgeCode();
        assert.match(code, /^ID-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
        assert.match(code, /^[A-Z0-9-]{6,32}$/, 'matches the kiosk_badges_code_chk constraint');
        seen.add(code);
    }
    assert.equal(seen.size, 500);
});

test('what a scanner sends is cleaned into a badge code', () => {
    assert.equal(so.normalizeBadgeCode('id-alex2345\r'), 'ID-ALEX2345');
    assert.equal(so.normalizeBadgeCode(' ID–ALEX2345 \t'), 'ID-ALEX2345', 'en dash from a keyboard layout');
    assert.equal(so.normalizeBadgeCode('ID-A'), '', 'too short to be a badge');
    assert.equal(so.normalizeBadgeCode('ID-AL EX;DROP'), '', 'junk is not a badge');
    assert.equal(so.normalizeBadgeCode(null), '');
    assert.equal(so.looksLikeBadge('id-alex2345'), true);
    assert.equal(so.looksLikeBadge('0051131020474'), false);
});

test('kiosk secrets are long, URL-safe, unique, and only their hash is derived', () => {
    const a = so.newKioskToken(), b = so.newKioskToken();
    assert.notEqual(a, b);
    assert.equal(so.validKioskToken(a), true);
    assert.equal(so.validKioskToken('short'), false);
    assert.equal(so.validKioskToken('x'.repeat(41) + '!'), false);
    assert.match(so.hashKioskToken(a), /^[0-9a-f]{64}$/);
    assert.equal(so.hashKioskToken(a), crypto.createHash('sha256').update(a).digest('hex'));
    assert.ok(!so.hashKioskToken(a).includes(a));
});

test('the ID badge requirement defaults to ON and can be turned off', () => {
    assert.equal(so.scanOutOptions({}).require_badge, true);
    assert.equal(so.scanOutOptions({ scan_out: { enabled: true } }).require_badge, true);
    assert.equal(so.scanOutOptions({ scan_out: { enabled: true, require_badge: false } }).require_badge, false);
    assert.equal(so.scanOutOptions({ scan_out: { idle_seconds: 5 } }).idle_seconds, 20, 'clamped up');
    assert.equal(so.scanOutOptions({ scan_out: { idle_seconds: 99999 } }).idle_seconds, 600, 'clamped down');
    assert.equal(so.scanOutOptions({ scan_out: { idle_seconds: 'x' } }).idle_seconds, 60);
});

test('the module needs inventory, is released and starts off with the badge scan on', () => {
    const spec = modules.MODULES.scan_out;
    assert.deepEqual(spec.requires, ['inventory']);
    assert.equal(spec.released, true);
    assert.equal(spec.defaults.enabled, false);
    assert.equal(spec.defaults.require_badge, true);
    assert.equal(modules.moduleEnabled({ scan_out: { enabled: true } }, 'scan_out'), false, 'off without inventory');
    assert.equal(modules.moduleEnabled({ inventory: { enabled: true }, scan_out: { enabled: true } }, 'scan_out'), true);
});

// ==================================================================
// The secret link
// ==================================================================
test('no link, a malformed link and an unknown link are all refused the same way', async () => {
    fake = seed();
    for (const token of ['', 'short', so.newKioskToken()]) {
        const r = await get('/api/kiosk/session', token);
        assert.equal(r.status, 401);
        assert.equal(r.body.error, 'This kiosk link is not valid.');
    }
});

test('a switched-off tablet and a deactivated company are refused', async () => {
    fake = seed();
    fake.db.kiosk_devices[0].is_active = false;
    assert.equal((await get('/api/kiosk/session')).status, 401);

    fake = seed();
    fake.db.companies[0].is_active = false;
    assert.equal((await get('/api/kiosk/session')).status, 401);
});

test('a company with the kiosk module (or inventory) off cannot use its tablet', async () => {
    fake = seed();
    fake.db.companies[0].settings.scan_out.enabled = false;
    const off = await get('/api/kiosk/session');
    assert.equal(off.status, 403);
    assert.match(off.body.error, /switched off/i);

    fake = seed();
    fake.db.companies[0].settings.inventory.enabled = false;
    assert.equal((await get('/api/kiosk/session')).status, 403);
});

test('a tablet whose location was deactivated is refused', async () => {
    fake = seed();
    fake.db.company_locations[0].is_active = false;
    assert.equal((await get('/api/kiosk/session')).status, 403);
});

test('the session tells the tablet its name and options, and nothing secret', async () => {
    fake = seed({ idle_seconds: 45 });
    const r = await get('/api/kiosk/session');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
        company: 'Assured Collision', location: 'Burlington', device: 'Paint room tablet',
        require_badge: true, idle_seconds: 45, ordering: false
    });
    assert.ok(!JSON.stringify(r.body).includes(TOKEN));
});

test('a kiosk link does not unlock the storefront, admin or inventory APIs', async () => {
    // Those APIs require a company or admin JWT; the kiosk header is just an
    // unknown header to them. Mounted with the real inventory router and the
    // real (stubbed-to-reject) company guard.
    fake = seed();
    const inventoryStore = require('../routes/inventory-store');
    const a = express();
    a.use(express.json());
    a.use('/api/store/:slug/inventory', inventoryStore);
    const r = await request(a).get('/api/store/assured/inventory/levels?location_id=' + LOC).set('X-Kiosk-Token', TOKEN);
    assert.equal(r.status, 401);
});

// ==================================================================
// Resolving a scan
// ==================================================================
test('a badge scan resolves to the person, without echoing the code', async () => {
    fake = seed();
    const r = await get('/api/kiosk/resolve?code=' + encodeURIComponent('id-alex2345'));
    assert.equal(r.status, 200);
    assert.equal(r.body.kind, 'badge');
    assert.deepEqual(r.body.badge, { id: BADGE_ID, name: 'Alex Painter', trade: 'painter' });
    assert.ok(!JSON.stringify(r.body).includes(BADGE_CODE));
});

test('an unknown or deactivated badge is not recognised', async () => {
    fake = seed();
    assert.equal((await get('/api/kiosk/resolve?code=ID-NOBODY99')).status, 404);
    const off = await get('/api/kiosk/resolve?code=' + OFF_CODE);
    assert.equal(off.status, 404);
    assert.equal(off.body.kind, 'none');
});

test('a product scan resolves by barcode, with no price and no stock level', async () => {
    fake = seed();
    const r = await get('/api/kiosk/resolve?code=0051131020474');
    assert.equal(r.status, 200);
    assert.equal(r.body.kind, 'product');
    assert.equal(r.body.product.id, P_MASK);
    assert.equal(r.body.product.name, 'Respirator mask');
    const wire = JSON.stringify(r.body);
    assert.ok(!/price|on_hand|49\.5/.test(wire), 'the kiosk never sees prices or stock');
});

test('a typed or label part number resolves by SKU', async () => {
    fake = seed();
    const r = await get('/api/kiosk/resolve?code=tape-18');
    assert.equal(r.status, 200);
    assert.equal(r.body.product.id, P_TAPE);
});

test('a barcode shared by two items asks the person to choose', async () => {
    fake = seed();
    const r = await get('/api/kiosk/resolve?code=SHARED-1');
    assert.equal(r.status, 200);
    assert.equal(r.body.kind, 'choose');
    assert.deepEqual(r.body.products.map(p => p.id).sort(), [P_DUP_A, P_DUP_B]);
});

test('another company’s product, and nonsense, are not found', async () => {
    fake = seed();
    assert.equal((await get('/api/kiosk/resolve?code=OTHER-1')).status, 404);
    assert.equal((await get('/api/kiosk/resolve?code=zzzz-nothing')).status, 404);
    assert.equal((await get('/api/kiosk/resolve')).status, 400);
});

// ==================================================================
// Scanning out
// ==================================================================
test('a badge-holder’s scan-out lands in the ledger against them and the tablet', async () => {
    fake = seed();
    const r = await post('/api/kiosk/scan-out', {
        session_id: SESSION, badge_code: 'id-alex2345',
        items: [{ product_id: P_MASK, quantity: 2, scanned_barcode: '0051131020474' },
                { product_id: P_TAPE, quantity: 1 }]
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.person, 'Alex Painter');

    assert.equal(movements().length, 2);
    const m = movements().find(x => x.product_id === P_MASK);
    assert.equal(m.movement_type, 'consume');
    assert.equal(Number(m.qty_change), -2);
    assert.equal(m.actor_type, 'kiosk');
    assert.equal(m.actor_label, 'Alex Painter');
    assert.equal(m.badge_id, BADGE_ID);
    assert.equal(m.kiosk_device_id, DEVICE_ID);
    assert.equal(m.location_id, LOC);
    assert.equal(m.source_doc_type, 'kiosk_scan');
    assert.equal(m.source_doc_id, SESSION);
    assert.equal(m.scanned_barcode, '0051131020474');
    assert.equal(onHand(P_MASK), 8);
    assert.equal(onHand(P_TAPE), 1);
});

test('with the ID badge required, a scan-out without one is refused', async () => {
    fake = seed();
    const r = await post('/api/kiosk/scan-out', { session_id: SESSION, items: [{ product_id: P_MASK, quantity: 1 }] });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'badge_required');
    assert.equal(movements().length, 0);
});

test('an unknown or deactivated badge cannot scan out', async () => {
    fake = seed();
    for (const code of ['ID-NOBODY99', OFF_CODE]) {
        const r = await post('/api/kiosk/scan-out', { session_id: SESSION, badge_code: code, items: [{ product_id: P_MASK, quantity: 1 }] });
        assert.equal(r.status, 400);
        assert.equal(r.body.code, 'bad_badge');
    }
    assert.equal(movements().length, 0);
});

test('with the ID badge turned OFF, items scan out with no person recorded', async () => {
    fake = seed({ require_badge: false });
    const session = await get('/api/kiosk/session');
    assert.equal(session.body.require_badge, false);

    const r = await post('/api/kiosk/scan-out', { session_id: SESSION, items: [{ product_id: P_MASK, quantity: 3 }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.person, null);

    const m = movements()[0];
    assert.equal(m.actor_label, 'Kiosk — Paint room tablet');
    assert.equal(m.badge_id, null);
    assert.equal(m.kiosk_device_id, DEVICE_ID, 'the tablet is still recorded');
    assert.equal(onHand(P_MASK), 7);
});

test('with the badge OFF, a person who does scan their badge is still recorded', async () => {
    fake = seed({ require_badge: false });
    const r = await post('/api/kiosk/scan-out', { session_id: SESSION, badge_code: BADGE_CODE, items: [{ product_id: P_MASK, quantity: 1 }] });
    assert.equal(r.status, 201);
    assert.equal(movements()[0].actor_label, 'Alex Painter');
    assert.equal(movements()[0].badge_id, BADGE_ID);
});

test('a retry with the same session never posts a line twice', async () => {
    fake = seed();
    const body = { session_id: SESSION, badge_code: BADGE_CODE, items: [{ product_id: P_MASK, quantity: 2 }] };
    assert.equal((await post('/api/kiosk/scan-out', body)).status, 201);
    const again = await post('/api/kiosk/scan-out', body);
    assert.equal(again.status, 201);
    assert.equal(again.body.results[0].duplicate, true);
    assert.equal(movements().length, 1);
    assert.equal(onHand(P_MASK), 8);
});

test('repeat scans of one product are merged into one line', async () => {
    fake = seed();
    const r = await post('/api/kiosk/scan-out', {
        session_id: SESSION, badge_code: BADGE_CODE,
        items: [{ product_id: P_MASK, quantity: 1 }, { product_id: P_MASK, quantity: 2 }]
    });
    assert.equal(r.status, 201);
    assert.equal(movements().length, 1);
    assert.equal(Number(movements()[0].qty_change), -3);
});

test('taking more than is on hand is refused with a plain reason, and the rest still goes through', async () => {
    fake = seed();
    const r = await post('/api/kiosk/scan-out', {
        session_id: SESSION, badge_code: BADGE_CODE,
        items: [{ product_id: P_TAPE, quantity: 5 }, { product_id: P_MASK, quantity: 1 }]
    });
    assert.equal(r.status, 207);
    assert.equal(r.body.ok, false);
    const tape = r.body.results.find(x => x.product_id === P_TAPE);
    assert.equal(tape.ok, false);
    assert.match(tape.error, /Only 2 on hand/);
    assert.equal(onHand(P_TAPE), 2, 'untouched');
    assert.equal(onHand(P_MASK), 9);
});

test('a company that allows negative stock lets the scan-out through', async () => {
    fake = seed({}, { allow_negative: true });
    const r = await post('/api/kiosk/scan-out', { session_id: SESSION, badge_code: BADGE_CODE, items: [{ product_id: P_TAPE, quantity: 5 }] });
    assert.equal(r.status, 201);
    assert.equal(onHand(P_TAPE), -3);
});

test('a failed line can be fixed and re-sent under the same session', async () => {
    fake = seed();
    const first = await post('/api/kiosk/scan-out', {
        session_id: SESSION, badge_code: BADGE_CODE,
        items: [{ product_id: P_TAPE, quantity: 5 }, { product_id: P_MASK, quantity: 1 }]
    });
    assert.equal(first.status, 207);
    const second = await post('/api/kiosk/scan-out', {
        session_id: SESSION, badge_code: BADGE_CODE,
        items: [{ product_id: P_TAPE, quantity: 2 }]
    });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(onHand(P_TAPE), 0);
    assert.equal(onHand(P_MASK), 9, 'the mask was not taken twice');
});

test('a scan-out that crosses the minimum drafts a reorder, like a phone scan does', async () => {
    fake = seed();
    await post('/api/kiosk/scan-out', { session_id: SESSION, badge_code: BADGE_CODE, items: [{ product_id: P_MASK, quantity: 7 }] });
    assert.equal(onHand(P_MASK), 3);
    assert.equal(fake.db.replenishment_orders.length, 1);
    assert.equal(fake.db.replenishment_orders[0].created_by_label, 'Alex Painter');
});

test('bad input is refused before anything is written', async () => {
    fake = seed();
    const ok = { session_id: SESSION, badge_code: BADGE_CODE };
    const cases = [
        { ...ok, session_id: 'nope', items: [{ product_id: P_MASK, quantity: 1 }] },
        { ...ok, items: [] },
        { ...ok },
        { ...ok, items: [{ product_id: 'not-a-uuid', quantity: 1 }] },
        { ...ok, items: [{ product_id: P_MASK, quantity: 0 }] },
        { ...ok, items: [{ product_id: P_MASK, quantity: -4 }] },
        { ...ok, items: [{ product_id: P_MASK, quantity: 1001 }] },
        { ...ok, items: [{ product_id: P_MASK, quantity: 'lots' }] },
        { ...ok, items: Array.from({ length: 101 }, () => ({ product_id: P_MASK, quantity: 1 })) }
    ];
    for (const body of cases) {
        const r = await post('/api/kiosk/scan-out', body);
        assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    }
    assert.equal(movements().length, 0);
});

test('a kiosk cannot scan out another company’s product', async () => {
    fake = seed();
    const r = await post('/api/kiosk/scan-out', { session_id: SESSION, badge_code: BADGE_CODE, items: [{ product_id: P_OTHER, quantity: 1 }] });
    assert.equal(r.status, 409);
    assert.equal(r.body.results[0].ok, false);
    assert.equal(movements().length, 0);
});

test('switching the tablet off ends its access immediately', async () => {
    fake = seed();
    assert.equal((await get('/api/kiosk/session')).status, 200);
    const off = await request(adminApp()).delete(`${A}/devices/${DEVICE_ID}`);
    assert.equal(off.status, 200);
    assert.equal((await get('/api/kiosk/session')).status, 401);
});

// ==================================================================
// Console: settings, tablets, people, badges
// ==================================================================
test('console: the whole panel loads in one call and never exposes a link secret', async () => {
    fake = seed();
    const r = await request(adminApp()).get(A);
    assert.equal(r.status, 200);
    assert.equal(r.body.module_enabled, true);
    assert.equal(r.body.options.require_badge, true);
    assert.equal(r.body.devices.length, 1);
    assert.equal(r.body.devices[0].location_name, 'Burlington');
    const wire = JSON.stringify(r.body);
    assert.ok(!wire.includes(TOKEN) && !wire.includes('token_hash'));
    assert.equal(r.body.badges.length, 2);
});

test('console: the ID-badge switch saves, keeps every other setting, and is audited', async () => {
    fake = seed({ idle_seconds: 90 });
    fake.db.companies[0].settings.po = { keep: 'me' };
    const r = await request(adminApp()).put(`${A}/settings`).send({ require_badge: false });
    assert.equal(r.status, 200);
    assert.match(r.body.message, /^Updated/);
    assert.match(r.body.message, /OFF/);

    const s = fake.db.companies[0].settings;
    assert.equal(s.scan_out.require_badge, false);
    assert.equal(s.scan_out.enabled, true, 'the module stays on');
    assert.equal(s.scan_out.idle_seconds, 90);
    assert.deepEqual(s.po, { keep: 'me' });
    assert.equal(s.inventory.enabled, true);
    assert.ok(fake.db.audit_log.some(a => a.action === 'scan_out_settings'));

    const back = await request(adminApp()).put(`${A}/settings`).send({ require_badge: true });
    assert.match(back.body.message, /must scan/);
    assert.equal(fake.db.companies[0].settings.scan_out.require_badge, true);
});

test('console: settings reject junk', async () => {
    fake = seed();
    for (const body of [{}, { require_badge: 'no' }, { idle_seconds: 5 }, { idle_seconds: 9999 }, { idle_seconds: 'x' }]) {
        assert.equal((await request(adminApp()).put(`${A}/settings`).send(body)).status, 400, JSON.stringify(body));
    }
});

test('console: a new tablet gets a link once, and only its hash is stored', async () => {
    fake = seed();
    const r = await request(adminApp()).post(`${A}/devices`).send({ name: 'Cage tablet', location_id: LOC });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const m = r.body.link.match(/\/kiosk\/([A-Za-z0-9_-]{40,60})$/);
    assert.ok(m, 'the link ends in the secret');

    const row = fake.db.kiosk_devices.find(d => d.name === 'Cage tablet');
    assert.equal(row.token_hash, so.hashKioskToken(m[1]));
    assert.ok(!JSON.stringify(fake.db.kiosk_devices).includes(m[1]), 'the secret itself is never stored');
    assert.equal(row.token_hint, m[1].slice(-4));

    // and the link works
    assert.equal((await get('/api/kiosk/session', m[1])).status, 200);
});

test('console: a tablet needs the module on, a name, and one of this company’s locations', async () => {
    fake = seed();
    assert.equal((await request(adminApp()).post(`${A}/devices`).send({ location_id: LOC })).status, 400);
    assert.equal((await request(adminApp()).post(`${A}/devices`).send({ name: 'x', location_id: 'nope' })).status, 400);
    assert.equal((await request(adminApp()).post(`${A}/devices`).send({ name: 'x', location_id: OTHER_LOC })).status, 400);

    fake = seed();
    fake.db.companies[0].settings.scan_out.enabled = false;
    const off = await request(adminApp()).post(`${A}/devices`).send({ name: 'x', location_id: LOC });
    assert.equal(off.status, 400);
    assert.match(off.body.error, /Turn on the Scan-out kiosk/);
});

test('console: a new link kills the old one', async () => {
    fake = seed();
    const r = await request(adminApp()).post(`${A}/devices/${DEVICE_ID}/regenerate`);
    assert.equal(r.status, 200);
    const fresh = r.body.link.split('/kiosk/')[1];
    assert.equal((await get('/api/kiosk/session', TOKEN)).status, 401, 'old link dead');
    assert.equal((await get('/api/kiosk/session', fresh)).status, 200, 'new link works');
});

test('console: a tablet can be renamed and moved, but only within the company', async () => {
    fake = seed();
    const ok = await request(adminApp()).put(`${A}/devices/${DEVICE_ID}`).send({ name: 'Renamed' });
    assert.equal(ok.status, 200);
    assert.equal(fake.db.kiosk_devices[0].name, 'Renamed');
    assert.equal((await request(adminApp()).put(`${A}/devices/${DEVICE_ID}`).send({ location_id: OTHER_LOC })).status, 400);
});

test('console: one tablet in another company cannot be touched through this company', async () => {
    fake = seed();
    fake.db.kiosk_devices.push({ id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', company_id: OTHER, location_id: OTHER_LOC, name: 'Theirs', token_hash: 'x', is_active: true });
    const r = await request(adminApp()).delete(`${A}/devices/cccccccc-cccc-4ccc-8ccc-ccccccccccc1`);
    assert.equal(r.status, 404);
    assert.equal(fake.db.kiosk_devices.find(d => d.name === 'Theirs').is_active, true);
});

test('console: adding people mints unique codes and cleans the trade', async () => {
    fake = seed();
    const one = await request(adminApp()).post(`${A}/badges`).send({ name: '  Sam <b>Bodyman</b> ', trade: 'BodyMan' });
    assert.equal(one.status, 201);
    assert.equal(one.body.badge.name, 'Sam Bodyman');
    assert.equal(one.body.badge.trade, 'bodyman');
    assert.match(one.body.badge.badge_code, /^ID-/);

    const junk = await request(adminApp()).post(`${A}/badges`).send({ name: 'Pat', trade: 'wizard' });
    assert.equal(junk.body.badge.trade, null);

    assert.equal((await request(adminApp()).post(`${A}/badges`).send({ name: '   ' })).status, 400);

    const bulk = await request(adminApp()).post(`${A}/badges/bulk`).send({ names: 'Ann One, painter\nBo Two\n\nCy Three, cage' });
    assert.equal(bulk.status, 201);
    assert.equal(bulk.body.badges.length, 3);
    assert.deepEqual(bulk.body.badges.map(b => b.trade), ['painter', null, 'cage']);

    const codes = fake.db.kiosk_badges.map(b => b.badge_code);
    assert.equal(new Set(codes).size, codes.length, 'every code is unique');
});

test('console: removing a person switches their badge off at the kiosk, and keeps history', async () => {
    fake = seed();
    assert.equal((await get('/api/kiosk/resolve?code=' + BADGE_CODE)).status, 200);
    const r = await request(adminApp()).delete(`${A}/badges/${BADGE_ID}`);
    assert.equal(r.status, 200);
    assert.equal(fake.db.kiosk_badges.find(b => b.id === BADGE_ID).is_active, false, 'switched off, not deleted');
    assert.equal((await get('/api/kiosk/resolve?code=' + BADGE_CODE)).status, 404);

    const back = await request(adminApp()).put(`${A}/badges/${BADGE_ID}`).send({ is_active: true });
    assert.equal(back.status, 200);
    assert.equal((await get('/api/kiosk/resolve?code=' + BADGE_CODE)).status, 200);
});

test('console: a reissued badge gets a new code and the old card stops working', async () => {
    fake = seed();
    const r = await request(adminApp()).post(`${A}/badges/${BADGE_ID}/reissue`);
    assert.equal(r.status, 200);
    assert.notEqual(r.body.badge.badge_code, BADGE_CODE);
    assert.equal((await get('/api/kiosk/resolve?code=' + BADGE_CODE)).status, 404, 'old card dead');
    assert.equal((await get('/api/kiosk/resolve?code=' + r.body.badge.badge_code)).status, 200, 'new card works');
});

test('console: the badge sheet prints credit-card badges with barcodes and escapes names', async () => {
    fake = seed();
    fake.db.kiosk_badges.push({ id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1', company_id: CO, name: '<script>alert(1)</script>', trade: null, badge_code: 'ID-EVIL2345', is_active: true });
    const r = await request(adminApp()).get(`${A}/badges/sheet`);
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.match(r.text, /Alex Painter/);
    assert.match(r.text, /<svg/);
    assert.ok(!r.text.includes('<script>alert(1)</script>'), 'names are escaped');
    assert.ok(!r.text.includes('Gone Person'), 'deactivated people are not printed');
    assert.match(r.text, /85\.6mm/);

    const one = await request(adminApp()).get(`${A}/badges/sheet?ids=${BADGE_ID}`);
    assert.equal(one.status, 200);
    assert.ok(!one.text.includes('EVIL'));
    assert.equal((await request(adminApp()).get(`${A}/badges/sheet?ids=nope`)).status, 400);
});

test('console: recent scan-outs show who took what', async () => {
    fake = seed();
    await post('/api/kiosk/scan-out', { session_id: SESSION, badge_code: BADGE_CODE, items: [{ product_id: P_MASK, quantity: 2 }] });
    const r = await request(adminApp()).get(`${A}/activity`);
    assert.equal(r.status, 200);
    assert.equal(r.body.activity.length, 1);
    assert.deepEqual(
        { who: r.body.activity[0].who, sku: r.body.activity[0].sku, quantity: r.body.activity[0].quantity },
        { who: 'Alex Painter', sku: 'MASK-1', quantity: 2 });
});

// ==================================================================
// The page, the migration, and what must NOT change
// ==================================================================
test('the kiosk page sends its secret as a header, stores nothing, and loads nothing from outside', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public/kiosk.html'), 'utf8');
    assert.match(html, /X-Kiosk-Token/);
    assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(html), 'no browser storage');
    assert.ok(!/<script[^>]+src=|<link[^>]+href=["']https?:/i.test(html), 'no external scripts or styles');
    assert.ok(!/company-login|access_code|\/api\/auth|admin-login/i.test(html), 'it has no sign-in of any kind');
    // The one Authorization header is the narrow order session, sent only to the store's order endpoints.
    assert.equal((html.match(/Authorization/g) || []).length, 1);
    assert.match(html, /'Authorization': 'Bearer ' \+ \(orderCtx \? orderCtx\.token : ''\)/);
    assert.match(html, /noindex/);
});

test('every id the page reads exists in its markup', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public/kiosk.html'), 'utf8');
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
    const used = new Set([...html.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]));
    for (const u of used) {
        if (u.startsWith('s-')) { assert.ok(ids.has(u), `missing #${u}`); continue; }
        assert.ok(ids.has(u), `missing #${u}`);
    }
});

test('the migration is idempotent, locks the tables down, and keeps the ledger append-only-safe', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'migrations/053_scan_out_kiosk.sql'), 'utf8');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.kiosk_devices/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.kiosk_badges/);
    assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
    assert.match(sql, /actor_type IN \('admin','store','system','kiosk'\)/);
    assert.ok(!/badge_id\s+uuid\s+REFERENCES|kiosk_device_id\s+uuid\s+REFERENCES/i.test(sql), 'no FKs on the append-only ledger');
    assert.ok(!/UPDATE\s+public\.companies|settings/i.test(sql.replace(/--.*$/gm, '')), 'the migration touches no company settings or sign-in');
});

test('the kiosk touches no sign-in code', () => {
    for (const f of ['routes/kiosk.js', 'routes/scan-out-admin.js', 'utils/scan-out.js']) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
        assert.ok(!/require_individual_login|access_code|company-login|users\.enabled|'users'|"users"/.test(src), `${f} must not touch company sign-in settings`);
    }
    // The only settings key the console writes is scan_out.
    const admin = fs.readFileSync(path.join(ROOT, 'routes/scan-out-admin.js'), 'utf8');
    assert.deepEqual([...new Set([...admin.matchAll(/withModule\(company\.settings, '([a-z_]+)'/g)].map(m => m[1]))], ['scan_out']);
});

test('the site-wide limiter steps aside for the kiosk, which has its own limits', () => {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.match(server, /skip:\s*\(req\)\s*=>\s*req\.originalUrl\.startsWith\('\/api\/kiosk\/'\)/);
    assert.match(server, /app\.use\('\/api\/kiosk', require\('\.\/routes\/kiosk'\)\)/);
    const k = fs.readFileSync(path.join(ROOT, 'routes/kiosk.js'), 'utf8');
    assert.match(k, /router\.use\(badLinkLimiter\)/);
    assert.match(k, /router\.use\(tabletLimiter\)/);
});
