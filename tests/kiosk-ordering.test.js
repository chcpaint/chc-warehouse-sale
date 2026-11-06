/**
 * tests/kiosk-ordering.test.js
 *
 * Stock ordering from the scan-out kiosk: a manager taps "Place Stock Order",
 * enters the company's order passcode, scans items and sends the order.
 *
 * Runs through the REAL company-auth guard and the REAL storefront order route,
 * because the two things worth proving are exactly the seams between them:
 *   - the order session a passcode buys is narrow (it can order for its own
 *     tablet's location and do nothing else in the store);
 *   - the order it places is the store's own order, with the store's rules.
 *
 *   node --test tests/kiosk-ordering.test.js
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const jwt = require('jsonwebtoken');

const { createFakeSupabase } = require('./helpers/fake-supabase');

const ROOT = path.resolve(__dirname, '..');
let fake = createFakeSupabase();
const sent = { orders: [] };

const supabaseProxy = new Proxy({}, {
    get: (_t, prop) => {
        const v = fake[prop];
        return typeof v === 'function' ? v.bind(fake) : v;
    }
});

// Everything stubbed EXCEPT middleware/auth.js: the real guard is under test.
const stubs = {
    [path.join(ROOT, 'utils/supabase.js')]: { supabaseAdmin: supabaseProxy },
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
const kioskRouter = require('../routes/kiosk');
const adminRouter = require('../routes/scan-out-admin');
const storefront = require('../routes/storefront');
const so = require('../utils/scan-out');

// ------------------------------------------------------------------
const CO = '11111111-1111-4111-8111-111111111111';
const OTHER_CO = '22222222-2222-4222-8222-222222222222';
const LOC = '33333333-3333-4333-8333-333333333333';
const LOC2 = '44444444-4444-4444-8444-444444444444';
const P1 = '55555555-5555-4555-8555-555555555501';
const P2 = '55555555-5555-4555-8555-555555555502';
const DEVICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const TOKEN = so.newKioskToken();
const PASSCODE = '482915';

async function seed({ scanOut = {}, settings = {}, locExtra = {}, withPasscode = true } = {}) {
    fake = createFakeSupabase({
        companies: [
            { id: CO, name: 'Assured Collision', slug: 'assured', is_active: true, contact_email: 'shop@example.invalid', email_config: {},
              settings: { inventory: { enabled: true }, purchase_orders: { mode: 'manual', optional_below: 500 },
                          scan_out: { enabled: true, order_enabled: true, order_contact_name: 'Stock room', order_contact_email: 'stock@assured.example', ...scanOut },
                          ...settings } },
            { id: OTHER_CO, name: 'Other', slug: 'other', is_active: true, settings: {} }
        ],
        company_locations: [
            { id: LOC, company_id: CO, name: 'Burlington', is_active: true, restrict_to_category: null, ...locExtra },
            { id: LOC2, company_id: CO, name: 'Oakville', is_active: true, restrict_to_category: null }
        ],
        products: [
            { id: P1, company_id: CO, sku: 'MASK-1', name: 'Respirator mask', category: 'Misc', price: 100, is_active: true, price_on_request: false },
            { id: P2, company_id: CO, sku: 'TAPE-18', name: 'Masking tape', category: 'Misc', price: 4, is_active: true, price_on_request: false }
        ],
        product_barcodes: [{ id: 'b1', product_id: P1, barcode: '0051131020474', symbology: 'ean_13', is_primary: true }],
        kiosk_devices: [{ id: DEVICE, company_id: CO, location_id: LOC, name: 'Stock room tablet', token_hash: so.hashKioskToken(TOKEN), is_active: true }],
        kiosk_order_access: withPasscode ? [{ company_id: CO, passcode_hash: await so.hashPasscode(PASSCODE), changed_at: new Date().toISOString(), changed_by: 'test' }] : [],
        company_po_sequences: []
    });
    sent.orders = [];
}

function app() {
    const a = express();
    a.use(express.json());
    a.use('/api/kiosk', kioskRouter);
    a.use('/api/store', storefront);
    return a;
}
function adminApp() {
    const a = express();
    a.use(express.json());
    a.use((req, res, next) => { req.admin = { id: 'admin-1', role: 'super_admin' }; next(); });
    a.use('/api/admin/companies/:companyId/inventory/scan-out', adminRouter);
    return a;
}
const k = (method, url, body, token = TOKEN) => {
    const r = request(app())[method](url).set('X-Kiosk-Token', token);
    return body ? r.send(body) : r;
};
const unlock = (passcode = PASSCODE) => k('post', '/api/kiosk/order/unlock', { passcode });
async function orderToken() { const r = await unlock(); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.token; }
const store = (method, url, token, body) => {
    const r = request(app())[method](url).set('Authorization', `Bearer ${token}`);
    return body ? r.send(body) : r;
};
const A = `/api/admin/companies/${CO}/inventory/scan-out`;
const orderBody = (items, extra = {}) => ({
    contact_name: 'Stock room', contact_email: 'stock@assured.example',
    location_id: LOC, items, ...extra
});

// ==================================================================
// Passcode rules (no database)
// ==================================================================
test('passcodes are 6-12 digits, not trivial, hashed with a salt and checked in constant time', async () => {
    for (const bad of ['12345', '1234567890123', 'abc123', '111111', '123456', '654321', '', '12 3456'])
        assert.ok(so.passcodeProblem(bad), `should refuse ${JSON.stringify(bad)}`);
    for (const good of ['482915', '90210547', '000471'])
        assert.equal(so.passcodeProblem(good), null, good);

    const h1 = await so.hashPasscode('482915'), h2 = await so.hashPasscode('482915');
    assert.notEqual(h1, h2, 'salted');
    assert.ok(!h1.includes('482915'));
    assert.equal(await so.verifyPasscode('482915', h1), true);
    assert.equal(await so.verifyPasscode('482916', h1), false);
    assert.equal(await so.verifyPasscode('482915', 'garbage'), false);
    assert.equal(await so.verifyPasscode(undefined, h1), false);
});

test('order contact details are cleaned', () => {
    assert.equal(so.cleanEmail('  Stock@Assured.Example '), 'stock@assured.example');
    assert.equal(so.cleanEmail('nope'), '');
    assert.equal(so.cleanEmail('a b@c.com'), '');
    assert.equal(so.cleanLine('  <b>Stock</b>   room '), 'Stock room');
    const o = so.scanOutOptions({ scan_out: { order_enabled: true, order_contact_email: 'X@Y.IO' } });
    assert.deepEqual([o.order_enabled, o.order_contact_email, o.order_contact_name], [true, 'x@y.io', '']);
    assert.equal(so.scanOutOptions({}).order_enabled, false, 'ordering is off by default');
});

// ==================================================================
// When the green bar appears
// ==================================================================
test('the order bar shows only when ordering is on AND a passcode is set', async () => {
    await seed();
    assert.equal((await k('get', '/api/kiosk/session')).body.ordering, true);

    await seed({ withPasscode: false });
    assert.equal((await k('get', '/api/kiosk/session')).body.ordering, false, 'no passcode yet');

    await seed({ scanOut: { order_enabled: false } });
    assert.equal((await k('get', '/api/kiosk/session')).body.ordering, false, 'switched off');
});

test('a company that orders as signed-in individuals never gets the bar', async () => {
    await seed({ settings: { users: { enabled: true }, activity: { enabled: true } } });
    assert.equal((await k('get', '/api/kiosk/session')).body.ordering, false);
    const r = await unlock();
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'individual_logins');
});

// ==================================================================
// Unlocking
// ==================================================================
test('the right passcode returns a short, narrow order session and what the screen needs', async () => {
    await seed({ locExtra: { orderer_names: ['Bav Mehan', 'Kartik Mehan'] } });
    const r = await unlock();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.orderer_names, ['Bav Mehan', 'Kartik Mehan']);
    assert.deepEqual(r.body.contact, { name: 'Stock room', email: 'stock@assured.example' });
    assert.equal(r.body.slug, 'assured');
    assert.deepEqual(r.body.location, { id: LOC, name: 'Burlington' });

    const claims = jwt.verify(r.body.token, process.env.JWT_SECRET);
    assert.equal(claims.scope, 'kiosk_order');
    assert.equal(claims.type, 'company');
    assert.equal(claims.location_id, LOC);
    assert.equal(claims.device_id, DEVICE);
    assert.ok(claims.exp - claims.iat <= 30 * 60, 'lasts 30 minutes at most');
});

test('a wrong passcode is refused, counted, and five of them lock the tablet', async () => {
    await seed();
    for (let i = 1; i <= 4; i++) {
        const r = await unlock('999000');
        assert.equal(r.status, 401);
        assert.equal(r.body.attempts_left, 5 - i);
    }
    const fifth = await unlock('999000');
    assert.equal(fifth.status, 429);
    assert.match(fifth.body.error, /Try again in 5 minutes/);

    // Even the right passcode is refused while locked.
    assert.equal((await unlock(PASSCODE)).status, 429);

    // After the lock runs out, the right one works and clears the count.
    fake.db.kiosk_devices[0].order_locked_until = new Date(Date.now() - 1000).toISOString();
    assert.equal((await unlock(PASSCODE)).status, 200);
    assert.equal(fake.db.kiosk_devices[0].order_fail_count, 0);
});

test('a right passcode part-way through clears the wrong-try count', async () => {
    await seed();
    await unlock('999000'); await unlock('999000');
    assert.equal((await unlock()).status, 200);
    assert.equal(fake.db.kiosk_devices[0].order_fail_count, 0);
});

test('unlocking needs a valid kiosk link, and non-numeric input never reaches the hash', async () => {
    await seed();
    assert.equal((await k('post', '/api/kiosk/order/unlock', { passcode: PASSCODE }, so.newKioskToken())).status, 401);
    const bad = await unlock('abc123');
    assert.equal(bad.status, 400);
    assert.equal(fake.db.kiosk_devices[0].order_fail_count || 0, 0, 'malformed input is not a guess');
});

test('no passcode, or ordering off, means nothing to unlock', async () => {
    await seed({ withPasscode: false });
    assert.equal((await unlock()).status, 403);
    await seed({ scanOut: { order_enabled: false } });
    assert.equal((await unlock()).status, 403);
});

// ==================================================================
// The order session is narrow
// ==================================================================
test('the order session can use the five store endpoints it needs', async () => {
    await seed();
    const t = await orderToken();
    assert.equal((await store('get', '/api/store/assured/products/lookup?code=0051131020474', t)).status, 200);
    assert.equal((await store('get', '/api/store/assured/po/config', t)).status, 200);
    assert.equal((await store('get', '/api/store/assured/tax/config', t)).status, 200);
    assert.equal((await store('get', '/api/store/assured/delivery-fee/config', t)).status, 200);
});

test('the order session can do nothing else in the store', async () => {
    await seed();
    const t = await orderToken();
    const denied = [
        ['get', '/api/store/assured/products'],
        ['get', '/api/store/assured/orders'],
        ['get', '/api/store/assured/reports/orders'],
        ['get', '/api/store/assured/reports/rebate'],
        ['get', '/api/store/assured/cart'],
        ['get', '/api/store/assured/promotions'],
        ['get', '/api/store/assured/locations'],
        ['get', '/api/store/assured/contact-notes'],
        ['get', `/api/store/assured/inventory/levels?location_id=${LOC}`],
        ['get', '/api/store/assured/inventory/summary?location_id=' + LOC],
        ['get', '/api/store/assured/users'],
        ['get', '/api/store/assured/kit-submissions'],
        ['get', '/api/store/assured/billing'],
        ['post', '/api/store/assured/cart/items'],
        ['post', '/api/store/assured/inventory/movements']
    ];
    for (const [method, url] of denied) {
        const r = await store(method, url, t, method === 'post' ? {} : undefined);
        assert.equal(r.status, 403, `${method.toUpperCase()} ${url} -> ${r.status}`);
    }
});

test('the order session works only in its own company’s store', async () => {
    await seed();
    const t = await orderToken();
    const r = await store('get', '/api/store/other/po/config', t);
    assert.equal(r.status, 403);
});

test('a forged, wrongly-scoped or expired order token is refused', async () => {
    await seed();
    const claims = { type: 'company', company_id: CO, slug: 'assured', location_id: LOC };
    const unknownScope = jwt.sign({ ...claims, scope: 'something_else' }, process.env.JWT_SECRET);
    assert.equal((await store('get', '/api/store/assured/po/config', unknownScope)).status, 403);
    const noLocation = jwt.sign({ ...claims, scope: 'kiosk_order', location_id: undefined }, process.env.JWT_SECRET);
    assert.equal((await store('get', '/api/store/assured/po/config', noLocation)).status, 403);
    const wrongSecret = jwt.sign({ ...claims, scope: 'kiosk_order' }, 'not-the-secret');
    assert.equal((await store('get', '/api/store/assured/po/config', wrongSecret)).status, 401);
    const expired = jwt.sign({ ...claims, scope: 'kiosk_order' }, process.env.JWT_SECRET, { expiresIn: -10 });
    assert.equal((await store('get', '/api/store/assured/po/config', expired)).status, 401);
    // a scope claim on an individual-user token is not honoured either
    const asUser = jwt.sign({ ...claims, type: 'company_user', scope: 'kiosk_order' }, process.env.JWT_SECRET);
    assert.equal((await store('get', '/api/store/assured/po/config', asUser)).status, 403);
});

test('ordinary company sessions are untouched by the new guard', async () => {
    await seed();
    const normal = jwt.sign({ type: 'company', company_id: CO, slug: 'assured', company_name: 'Assured' }, process.env.JWT_SECRET, { expiresIn: '24h' });
    for (const url of ['/api/store/assured/orders', '/api/store/assured/po/config', '/api/store/assured/locations', '/api/store/assured/products'])
        assert.equal((await store('get', url, normal)).status, 200, url);
});

// ==================================================================
// Placing the order
// ==================================================================
test('an order from the tablet is the store’s own order, at the tablet’s location', async () => {
    await seed();
    const t = await orderToken();
    const r = await store('post', '/api/store/assured/orders', t, orderBody([{ product_id: P2, quantity: 5 }], { notes: 'Stock-room tablet.' }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.order.id);

    const o = fake.db.orders[0];
    assert.equal(o.company_id, CO);
    assert.equal(o.location_id, LOC);
    assert.equal(o.contact_email, 'stock@assured.example');
    assert.equal(Number(o.subtotal), 20);
    assert.equal(o.po_number, null, 'under $500 before tax needs no PO (the store’s rule)');
});

test('the store’s PO rule applies: $500 or more needs a PO', async () => {
    await seed();
    const t = await orderToken();
    const noPo = await store('post', '/api/store/assured/orders', t, orderBody([{ product_id: P1, quantity: 5 }]));
    assert.equal(noPo.status, 400);
    assert.equal(noPo.body.po_required, true);
    const withPo = await store('post', '/api/store/assured/orders', t, orderBody([{ product_id: P1, quantity: 5 }], { po_number: 'PO-1234' }));
    assert.equal(withPo.status, 201, JSON.stringify(withPo.body));
    assert.equal(fake.db.orders[0].po_number, 'PO-1234');
});

test('the tablet’s location cannot be changed by the request', async () => {
    await seed();
    const t = await orderToken();
    const r = await store('post', '/api/store/assured/orders', t, orderBody([{ product_id: P2, quantity: 1 }], { location_id: LOC2 }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(fake.db.orders[0].location_id, LOC, 'forced to the tablet’s own location');
    // and a lookup is narrowed to that location too
    const noLoc = await store('post', '/api/store/assured/orders', t, { ...orderBody([{ product_id: P2, quantity: 1 }]), location_id: undefined });
    assert.equal(noLoc.status, 201);
    assert.equal(fake.db.orders[1].location_id, LOC);
});

test('a shop with a fixed list of orderers must pick one, exactly as in the store', async () => {
    await seed({ locExtra: { orderer_names: ['Bav Mehan'] } });
    const t = await orderToken();
    const wrong = await store('post', '/api/store/assured/orders', t, orderBody([{ product_id: P2, quantity: 1 }], { contact_name: 'Somebody Else' }));
    assert.equal(wrong.status, 400);
    const right = await store('post', '/api/store/assured/orders', t, orderBody([{ product_id: P2, quantity: 1 }], { contact_name: 'bav mehan' }));
    assert.equal(right.status, 201, JSON.stringify(right.body));
    assert.equal(fake.db.orders[0].contact_name, 'Bav Mehan');
});

test('a company with the module off loses the tablet but its order session still cannot widen', async () => {
    await seed();
    const t = await orderToken();
    fake.db.companies[0].settings.scan_out.order_enabled = false;
    assert.equal((await unlock()).status, 403, 'no new sessions once ordering is off');
    assert.equal((await k('get', '/api/kiosk/session')).body.ordering, false);
    assert.equal((await store('get', '/api/store/assured/orders', t)).status, 403, 'the old session is still narrow');
});

// ==================================================================
// Changing the passcode
// ==================================================================
test('passcode holders can change it themselves, with the current one', async () => {
    await seed();
    const r = await k('post', '/api/kiosk/order/passcode', { current: PASSCODE, next: '730184' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await unlock(PASSCODE)).status, 401, 'old one stops working');
    assert.equal((await unlock('730184')).status, 200, 'new one works');
    const row = fake.db.kiosk_order_access[0];
    assert.equal(row.changed_by, 'Tablet: Stock room tablet');
    assert.ok(!JSON.stringify(row).includes('730184'), 'stored only as a hash');
});

test('changing the passcode needs the current one, a good new one, and counts wrong tries', async () => {
    await seed();
    assert.equal((await k('post', '/api/kiosk/order/passcode', { current: '000999', next: '730184' })).status, 401);
    assert.equal((await k('post', '/api/kiosk/order/passcode', { current: PASSCODE, next: '123456' })).status, 400);
    assert.equal((await k('post', '/api/kiosk/order/passcode', { current: PASSCODE, next: PASSCODE })).status, 400);
    assert.equal((await k('post', '/api/kiosk/order/passcode', { current: PASSCODE, next: 'abcdef' })).status, 400);
    assert.equal((await unlock(PASSCODE)).status, 200, 'unchanged after the refusals');
    for (let i = 0; i < 5; i++) await k('post', '/api/kiosk/order/passcode', { current: '000999', next: '730184' });
    assert.equal((await k('post', '/api/kiosk/order/passcode', { current: PASSCODE, next: '730184' })).status, 429, 'guessing here locks the tablet too');
});

// ==================================================================
// Console
// ==================================================================
test('console: ordering status never exposes the passcode', async () => {
    await seed();
    const r = await request(adminApp()).get(A);
    assert.equal(r.status, 200);
    assert.deepEqual(
        { enabled: r.body.ordering.enabled, set: r.body.ordering.passcode_set, ready: r.body.ordering.ready, email: r.body.ordering.contact_email },
        { enabled: true, set: true, ready: true, email: 'stock@assured.example' });
    assert.ok(!JSON.stringify(r.body).includes('passcode_hash') && !JSON.stringify(r.body).includes(PASSCODE));
});

test('console: switch ordering on and off, and set the default contact', async () => {
    await seed({ scanOut: { order_enabled: false, order_contact_email: '' }, withPasscode: false });
    const on = await request(adminApp()).put(`${A}/ordering`).send({ enabled: true, contact_name: ' Stock <b>room</b> ', contact_email: 'Orders@Assured.example' });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.match(on.body.message, /^Updated/);
    const s = fake.db.companies[0].settings;
    assert.deepEqual([s.scan_out.order_enabled, s.scan_out.order_contact_name, s.scan_out.order_contact_email], [true, 'Stock room', 'orders@assured.example']);
    assert.equal(s.scan_out.enabled, true);
    assert.deepEqual(s.purchase_orders, { mode: 'manual', optional_below: 500 }, 'nothing else touched');
    assert.equal(on.body.ordering.ready, false, 'no passcode yet');

    assert.equal((await request(adminApp()).put(`${A}/ordering`).send({ contact_email: 'not an email' })).status, 400);
    assert.equal((await request(adminApp()).put(`${A}/ordering`).send({ enabled: 'yes' })).status, 400);
    assert.equal((await request(adminApp()).put(`${A}/ordering`).send({})).status, 400);

    const off = await request(adminApp()).put(`${A}/ordering`).send({ enabled: false });
    assert.match(off.body.message, /OFF/);
});

test('console: ordering cannot be switched on for a company that orders as individuals', async () => {
    await seed({ scanOut: { order_enabled: false }, settings: { users: { enabled: true }, activity: { enabled: true } } });
    const r = await request(adminApp()).put(`${A}/ordering`).send({ enabled: true });
    assert.equal(r.status, 400);
    const status = await request(adminApp()).get(A);
    assert.equal(status.body.ordering.available, false);
    assert.match(status.body.ordering.unavailable_reason, /signed-in individuals/);
});

test('console: setting a passcode replaces the old one, clears any lockout, and is never logged', async () => {
    await seed();
    for (let i = 0; i < 5; i++) await unlock('999000');
    assert.equal((await unlock(PASSCODE)).status, 429);

    const r = await request(adminApp()).put(`${A}/order-passcode`).send({ passcode: '573920' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ordering.passcode_changed_by, 'CHC console');
    assert.equal((await unlock('573920')).status, 200, 'works straight away, lockout cleared');
    assert.equal((await unlock(PASSCODE)).status, 401);
    assert.ok(!JSON.stringify(fake.db.audit_log).includes('573920'), 'the passcode never reaches the audit log');
    assert.ok(fake.db.audit_log.some(a => a.action === 'kiosk_order_passcode_set'));

    assert.equal((await request(adminApp()).put(`${A}/order-passcode`).send({ passcode: '111111' })).status, 400);
    assert.equal((await request(adminApp()).put(`${A}/order-passcode`).send({})).status, 400);
});

test('console: removing the passcode takes the bar away', async () => {
    await seed();
    const r = await request(adminApp()).delete(`${A}/order-passcode`);
    assert.equal(r.status, 200);
    assert.equal((await k('get', '/api/kiosk/session')).body.ordering, false);
    assert.equal((await unlock()).status, 403);
});

// ==================================================================
// The page and the migration
// ==================================================================
test('the order screen has the green bar, the Return popup and the 60 second auto-return', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public/kiosk.html'), 'utf8');
    assert.match(html, /id="btn-order"[^>]*>Place Stock Order</);
    assert.match(html, /Return to Scan Out Kiosk\?/);
    assert.match(html, /var RETURN_SECONDS = 60;/);
    assert.match(html, /returnAt = Date\.now\(\) \+ RETURN_SECONDS \* 1000/);
    assert.match(html, /background: var\(--ok\)/);
    assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(html));
    // The page only ever talks to its own kiosk API and the store's order endpoints.
    const urls = [...html.matchAll(/['"`]\/api\/[^'"`+]*/g)].map(m => m[0].slice(1));
    for (const u of urls) assert.ok(/^\/api\/(kiosk|store\/)/.test(u), u);
    for (const p of ['/products/lookup', '/po/config', '/orders']) assert.ok(html.includes(`'${p}`), p);
});

test('every id the page reads still exists in its markup', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public/kiosk.html'), 'utf8');
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
    for (const u of new Set([...html.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]))) assert.ok(ids.has(u), `missing #${u}`);
});

test('the scoped-token allowlist is exactly five store routes, default-deny', () => {
    const src = fs.readFileSync(path.join(ROOT, 'middleware/auth.js'), 'utf8');
    const block = src.match(/const SCOPED_ROUTES = \{[\s\S]*?\n\};/)[0];
    const routes = [...block.matchAll(/\['(GET|POST)',\s*'([^']+)'\]/g)].map(m => `${m[1]} ${m[2]}`);
    assert.deepEqual(routes, [
        'GET /:slug/products/lookup', 'GET /:slug/po/config', 'GET /:slug/tax/config',
        'GET /:slug/delivery-fee/config', 'POST /:slug/orders'
    ]);
});

test('migration 054: passcode table locked down, lockout columns, idempotent, no sign-in changes', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'migrations/054_kiosk_ordering.sql'), 'utf8');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.kiosk_order_access/);
    assert.match(sql, /passcode_hash text NOT NULL/);
    assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
    assert.match(sql, /order_fail_count/);
    assert.ok(!/UPDATE\s+public\.companies|access_code/i.test(sql.replace(/--.*$/gm, '')));
});

test('the passcode is never kept in company settings, where the storefront would send it to the browser', () => {
    for (const f of ['routes/kiosk.js', 'routes/scan-out-admin.js']) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        assert.ok(!/withModule\([^)]*passcode/.test(src), f);
        assert.ok(!/passcode_hash[^\n]*settings/.test(src), f);
    }
});

test('console panel: ordering controls exist, never touch sign-in settings, and ids line up', () => {
    const html = fs.readFileSync(path.join(ROOT, 'admin/index.html'), 'utf8');
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
    for (const id of ['so-order-on', 'so-order-name', 'so-order-email', 'so-pass-new', 'so-pass-status', 'so-pass-remove', 'so-order-hint', 'so-order-na'])
        assert.ok(ids.has(id), `missing #${id}`);
    const js = html.slice(html.indexOf('async function soSaveOrdering'), html.indexOf('function soShowLink'));
    assert.ok(js.includes("'/ordering'") && js.includes("'/order-passcode'"));
    assert.ok(!/access_code|individual|activity/.test(js.replace(/available|unavailable/g, '')), 'no sign-in settings');
    // The passcode box is a password field, so it is not shown on screen.
    assert.match(html, /id="so-pass-new" type="password"/);
});
