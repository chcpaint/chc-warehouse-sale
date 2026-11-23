/**
 * tests/ordering-rules.test.js
 *
 * Ordering rules and manager approvals (migration 071): the order limit, the
 * stock limit, orders on hold and items that need a manager, through the real
 * order route, the shop's approvals screen and the console.
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { createFakeSupabase } = require('./helpers/fake-supabase');
const { hashPasscode } = require('../utils/scan-out');

const ROOT = path.resolve(__dirname, '..');
let fake = createFakeSupabase();
let authCompany = null;
let authUser = null;
let admin = { id: 'a1', role: 'super_admin', name: 'CHC Admin' };
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
            req.companyUser = authUser;
            next();
        },
        requireAdminAuth: (req, res, next) => { req.admin = admin; next(); },
        requireSuperAdmin: (req, res, next) => next(),
        requireCompanyAccess: (req, res, next) => { req.admin = admin; next(); },
        requireCompanyUser: (req, res, next) => next(),
        requireCompanyOwner: (req, res, next) => next(),
        requireFullAdmin: (req, res, next) => (['super_admin', 'admin'].includes(admin.role)
            ? next() : res.status(403).json({ error: 'Full admin only.' })),
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
        resolveOrderRecipients: async () => ({ to: ['branch@example.invalid'], staffTo: [], customerTo: [], replyTo: null }),
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
const rulesAdmin = require('../routes/ordering-rules-admin');
const R = require('../utils/ordering-rules');

const CO = '11111111-1111-4111-8111-111111111111';
const LOC = '33333333-3333-4333-8333-333333333333';
const LOC2 = '33333333-3333-4333-8333-333333333334';
const P100 = '55555555-5555-4555-8555-555555555501';  // $100
const P40 = '55555555-5555-4555-8555-555555555502';   // $40
const PTOOL = '55555555-5555-4555-8555-555555555503'; // $250, needs a manager
const MIKE = '77777777-7777-4777-8777-777777777701';
const SHOP2 = '77777777-7777-4777-8777-777777777702';

let hashes = null;
async function ensureHashes() {
    if (!hashes) hashes = { mike: await hashPasscode('482913'), shop2: await hashPasscode('730564') };
    return hashes;
}

async function reset({ rules = [], extra = {}, passcodes = true } = {}) {
    const h = await ensureHashes();
    fake = createFakeSupabase({
        companies: [{ id: CO, name: 'Weins', slug: 'weins', is_active: true, contact_email: 'shop@example.invalid', email_config: {}, settings: { purchase_orders: { mode: 'off' } } }],
        company_locations: [
            { id: LOC, company_id: CO, name: 'Weins 1', is_active: true, restrict_to_category: null },
            { id: LOC2, company_id: CO, name: 'Weins 2', is_active: true, restrict_to_category: null }
        ],
        products: [
            { id: P100, company_id: CO, sku: 'A-100', name: 'Hundred', category: 'Misc', price: 100, is_active: true, price_on_request: false, requires_approval: false },
            { id: P40, company_id: CO, sku: 'A-40', name: 'Forty', category: 'Misc', price: 40, is_active: true, price_on_request: false, requires_approval: false },
            { id: PTOOL, company_id: CO, sku: 'T-1', name: 'Belt sander', category: 'Equipment', brand: '3M', price: 250, is_active: true, price_on_request: false, requires_approval: true }
        ],
        ordering_rules: rules,
        approval_passcodes: passcodes ? [
            { id: MIKE, company_id: CO, location_id: null, name: 'Mike', passcode_hash: h.mike, is_active: true, use_count: 0 },
            { id: SHOP2, company_id: CO, location_id: LOC2, name: 'Shop 2 lead', passcode_hash: h.shop2, is_active: true, use_count: 0 }
        ] : [],
        approval_lockouts: [],
        order_approvals: [],
        orders: [],
        order_receipts: [],
        audit_log: [],
        ...extra
    });
    authCompany = { id: CO, name: 'Weins', slug: 'weins' };
    authUser = null;
    admin = { id: 'a1', role: 'super_admin', name: 'CHC Admin' };
    sent.orders = [];
}

function app() {
    const a = express(); a.use(express.json());
    a.use('/api/store', storefront);
    a.use('/api/admin/companies/:companyId/ordering-rules', rulesAdmin);
    return a;
}
const order = (lines, extra = {}) => ({
    contact_name: 'Pat Painter', contact_email: 'pat@example.invalid', location_id: LOC,
    items: lines.map(([product_id, quantity]) => ({ product_id, quantity })), ...extra
});
const companyRule = (fields) => ({ id: 'r-co', company_id: CO, location_id: null, ...fields });
const post = (body) => request(app()).post('/api/store/weins/orders').send(body);
const rows = (t) => fake.db[t];

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

test('a shop setting overrides the company, a blank one inherits, and a rule with no amount is off', () => {
    const co = { order_limit_on: true, order_limit: 500, hold_on: false, staff_items_on: true };
    assert.equal(R.effectiveRules(co, null).order_limit.on, true);
    assert.equal(R.effectiveRules(co, { order_limit: 200 }).order_limit.amount, 200);
    assert.equal(R.effectiveRules(co, { order_limit_on: false }).order_limit.on, false);
    assert.equal(R.effectiveRules(co, { hold_on: true }).hold.on, true);
    assert.equal(R.effectiveRules({ order_limit_on: true, order_limit: null }, null).order_limit.on, false);
    assert.equal(R.anyOn(R.effectiveRules(null, null)), false);
    assert.match(R.effectiveRules(null, { hold_on: true }).hold.message, /on hold/);
});

test('an order at the limit is fine; one cent over needs a manager; the stock sum is shown in full', () => {
    const rules = R.effectiveRules({ order_limit_on: true, order_limit: 500, stock_ceiling_on: true, stock_ceiling: 1000 }, null);
    assert.equal(R.evaluate({ rules, subtotal: 500 }).length, 0);
    const over = R.evaluate({ rules, subtotal: 500.01 });
    assert.equal(over[0].code, 'order_limit');
    assert.match(over[0].detail, /\$500\.01/);
    const stock = R.evaluate({ rules, subtotal: 100, stock: { on_shelf: 800, on_the_way: 150 } });
    assert.equal(stock[0].code, 'stock_ceiling');
    assert.equal(stock[0].after, 1050);
    assert.match(stock[0].detail, /\$800\.00 \+ on the way \$150\.00 \+ this order \$100\.00 = \$1,050\.00/);
    assert.equal(R.evaluate({ rules, subtotal: 40, stock: { on_shelf: 800, on_the_way: 150 } }).length, 0);
});

test('rule changes are checked: amounts, a rule switched on without its amount, and a shop left to inherit', () => {
    assert.equal(R.normalizeRulesPatch({ order_limit: '-5' }).ok, false);
    assert.equal(R.normalizeRulesPatch({ order_limit_on: true, order_limit: '' }).ok, false);
    assert.deepEqual(R.normalizeRulesPatch({ order_limit_on: true, order_limit: '$1,250.5' }).patch,
        { order_limit_on: true, order_limit: 1250.5 });
    assert.equal(R.normalizeRulesPatch({ hold_on: null }, { forLocation: true }).patch.hold_on, null);
    assert.equal(R.normalizeRulesPatch({ hold_on: null }).patch.hold_on, false);
    assert.equal(R.normalizeRulesPatch({ hold_message: '<b>Back Monday</b>' }).patch.hold_message, 'Back Monday');
});

test('before migration 071 the missing tables read as "no rules", so ordering carries on', async () => {
    assert.equal(R.missingTable({ code: 'PGRST205', message: "Could not find the table 'public.ordering_rules' in the schema cache" }), true);
    assert.equal(R.missingTable({ code: '42P01', message: 'relation "public.order_approvals" does not exist' }), true);
    assert.equal(R.missingTable({ code: '57014', message: 'canceling statement due to statement timeout' }), false);
});

// ---------------------------------------------------------------------------
// Placing an order
// ---------------------------------------------------------------------------

test('with no rules on, orders go straight to CHC exactly as before', async () => {
    await reset();
    const r = await post(order([[P100, 9]]));
    assert.equal(r.status, 201);
    assert.equal(sent.orders.length, 1);
    assert.equal(rows('orders')[0].approval, undefined);
});

test('over the order limit: the shop is shown the order, its total and why, and nothing is sent', async () => {
    await reset({ rules: [companyRule({ order_limit_on: true, order_limit: 150 })] });
    const r = await post(order([[P100, 2]]));
    assert.equal(r.status, 409);
    assert.equal(r.body.approval_required, true);
    assert.equal(r.body.reasons[0].code, 'order_limit');
    assert.equal(r.body.order.subtotal, 200);
    assert.ok(r.body.order.total >= 200);
    assert.equal(r.body.order.items[0].name, 'Hundred');
    assert.equal(r.body.has_passcodes, true);
    assert.equal(rows('orders').length, 0);
    assert.equal(sent.orders.length, 0);
});

test('a right passcode sends it now and records who approved; a wrong one counts down and then locks', async () => {
    await reset({ rules: [companyRule({ order_limit_on: true, order_limit: 150 })] });
    const bad = await post(order([[P100, 2]], { approval_passcode: '111222' }));
    assert.equal(bad.status, 401);
    assert.equal(bad.body.attempts_left, 4);
    assert.equal(rows('orders').length, 0);

    const good = await post(order([[P100, 2]], { approval_passcode: '482913' }));
    assert.equal(good.status, 201);
    assert.equal(good.body.order.approved_by, 'Mike');
    const placed = rows('orders')[0];
    assert.equal(placed.approval.via, 'passcode');
    assert.equal(placed.approval.approved_by, 'Mike');
    assert.equal(placed.approval.reasons[0].code, 'order_limit');
    assert.match(placed.status_history[0].note, /approved by Mike/);
    assert.equal(sent.orders.length, 1);

    for (let i = 0; i < 4; i++) await post(order([[P100, 2]], { approval_passcode: '999000' }));
    const locked = await post(order([[P100, 2]], { approval_passcode: '999000' }));
    assert.equal(locked.status, 429);
    const evenRight = await post(order([[P100, 2]], { approval_passcode: '482913' }));
    assert.equal(evenRight.status, 429, 'a locked shop stays locked for the wait, right passcode or not');
});

test('a passcode for one shop does not approve at another', async () => {
    await reset({ rules: [companyRule({ order_limit_on: true, order_limit: 150 })] });
    const r = await post(order([[P100, 2]], { approval_passcode: '730564' }));
    assert.equal(r.status, 401);
    const ok = await post(order([[P100, 2]], { location_id: LOC2, approval_passcode: '730564' }));
    assert.equal(ok.status, 201);
    assert.equal(ok.body.order.approved_by, 'Shop 2 lead');
});

test('an owner signed in with their own login approves their own order', async () => {
    await reset({
        rules: [companyRule({ hold_on: true })],
        extra: { company_users: [{ id: 'u-owner', company_id: CO, email: 'own@example.invalid', name: 'Olive Owner', role: 'owner', is_active: true, location_id: null }] }
    });
    authUser = { id: 'u-owner', name: 'Olive Owner', email: 'own@example.invalid', role: 'owner', location_id: null };
    const r = await post(order([[P40, 1]]));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(rows('orders')[0].approval.via, 'owner');
});

test('a shop’s own setting applies there only; the company default applies everywhere else', async () => {
    await reset({ rules: [{ id: 'r-l', company_id: CO, location_id: LOC2, hold_on: true }] });
    assert.equal((await post(order([[P40, 1]]))).status, 201);
    const held = await post(order([[P40, 1]], { location_id: LOC2 }));
    assert.equal(held.status, 409);
    assert.equal(held.body.reasons[0].code, 'hold');
});

test('items that need a manager: a painter can order sandpaper freely, the sander needs approval', async () => {
    await reset({ rules: [companyRule({ staff_items_on: true })] });
    assert.equal((await post(order([[P40, 3]]))).status, 201);
    const r = await post(order([[P40, 1], [PTOOL, 1]]));
    assert.equal(r.status, 409);
    assert.equal(r.body.reasons[0].code, 'staff_items');
    assert.match(r.body.reasons[0].detail, /Belt sander/);
    assert.deepEqual(r.body.reasons[0].items, [PTOOL]);
});

test('the stock limit counts the shelf, orders on the way (less what was received) and this order', async () => {
    const OPEN = '88888888-8888-4888-8888-888888888801';
    await reset({
        rules: [companyRule({ stock_ceiling_on: true, stock_ceiling: 1000 })],
        extra: {
            // 8 x the $100 item on the shelf = $800 (inventory_status is computed from this).
            inventory_levels: [{ id: 'lv1', company_id: CO, location_id: LOC, product_id: P100, on_hand: 8, is_tracked: true }],
            orders: [{ id: OPEN, company_id: CO, location_id: LOC, status: 'out_on_delivery', created_at: new Date().toISOString(),
                items: [{ product_id: P100, quantity: 3, unit_price: 100 }] }],
            order_receipts: [{ id: 'rc1', order_id: OPEN, product_id: P100, quantity_received: 2 }]
        }
    });
    // 800 on the shelf + 100 still on the way + 100 = 1000: at the limit, fine.
    assert.equal((await post(order([[P100, 1]]))).status, 201);
    rows('orders').forEach(o => { o.created_at = o.created_at || new Date().toISOString(); });   // the database sets this
    // The order just placed is now on the way too: 800 + 200 + 40 = 1040.
    const r = await post(order([[P40, 1]]));
    assert.equal(r.status, 409);
    assert.equal(r.body.reasons[0].code, 'stock_ceiling');
    assert.equal(r.body.reasons[0].on_the_way, 200);
    assert.equal(r.body.reasons[0].after, 1040);
});

// ---------------------------------------------------------------------------
// Waiting for approval
// ---------------------------------------------------------------------------

test('send for approval: saved as waiting, not an order, nothing to CHC, no PO used', async () => {
    await reset({ rules: [companyRule({ hold_on: true, hold_message: 'Month-end freeze until the 3rd.' })] });
    const r = await post(order([[P100, 1]], { hold_for_approval: true, notes: 'Booth 2' }));
    assert.equal(r.status, 202);
    assert.equal(r.body.held, true);
    assert.equal(rows('orders').length, 0);
    assert.equal(sent.orders.length, 0);
    const held = rows('order_approvals')[0];
    assert.equal(held.status, 'waiting');
    assert.equal(held.request.notes, 'Booth 2');
    assert.equal(held.reasons[0].detail, 'Month-end freeze until the 3rd.');
});

test('a manager sees it, re-priced now, and releases it with a passcode; it goes to CHC once', async () => {
    await reset({ rules: [companyRule({ hold_on: true })] });
    await post(order([[P100, 2]], { hold_for_approval: true }));
    const id = rows('order_approvals')[0].id;

    const list = await request(app()).get(`/api/store/weins/ordering-rules/approvals?location_id=${LOC}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.waiting.length, 1);

    // A price change after it was sent is what the manager sees and approves.
    rows('products').find(p => p.id === P100).price = 110;
    const one = await request(app()).get(`/api/store/weins/ordering-rules/approvals/${id}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.preview.subtotal, 220);
    assert.equal(one.body.preview.reasons[0].code, 'hold');

    const wrong = await request(app()).post(`/api/store/weins/ordering-rules/approvals/${id}/release`).send({ passcode: '123987' });
    assert.equal(wrong.status, 401);
    assert.equal(rows('orders').length, 0);

    const ok = await request(app()).post(`/api/store/weins/ordering-rules/approvals/${id}/release`).send({ passcode: '482913' });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.approved_by, 'Mike');
    const placed = rows('orders')[0];
    assert.equal(placed.subtotal, 220);
    assert.equal(placed.approval.via, 'release');
    assert.equal(placed.approval.approval_id, id);
    const after = rows('order_approvals')[0];
    assert.equal(after.status, 'released');
    assert.equal(after.order_id, placed.id);
    assert.equal(after.decided_by_name, 'Mike');
    assert.equal(sent.orders.length, 1);

    const again = await request(app()).post(`/api/store/weins/ordering-rules/approvals/${id}/release`).send({ passcode: '482913' });
    assert.equal(again.status, 409);
    assert.equal(rows('orders').length, 1);
});

test('a release that cannot be placed now puts the order back to waiting', async () => {
    await reset({ rules: [companyRule({ hold_on: true })] });
    await post(order([[P100, 1]], { hold_for_approval: true }));
    const id = rows('order_approvals')[0].id;
    rows('products').find(p => p.id === P100).is_active = false;
    rows('products').splice(rows('products').findIndex(p => p.id === P100), 1);
    const r = await request(app()).post(`/api/store/weins/ordering-rules/approvals/${id}/release`).send({ passcode: '482913' });
    assert.equal(r.status, 400);
    assert.equal(rows('order_approvals')[0].status, 'waiting');
    assert.equal(rows('order_approvals')[0].decided_by_name, null);
});

test('declining needs a reason and a passcode, and places nothing', async () => {
    await reset({ rules: [companyRule({ hold_on: true })] });
    await post(order([[P100, 1]], { hold_for_approval: true }));
    const id = rows('order_approvals')[0].id;
    const noReason = await request(app()).post(`/api/store/weins/ordering-rules/approvals/${id}/decline`).send({ passcode: '482913' });
    assert.equal(noReason.status, 400);
    const r = await request(app()).post(`/api/store/weins/ordering-rules/approvals/${id}/decline`)
        .send({ passcode: '482913', reason: 'We have two in the back.' });
    assert.equal(r.status, 200);
    assert.equal(rows('order_approvals')[0].status, 'declined');
    assert.equal(rows('order_approvals')[0].decision_reason, 'We have two in the back.');
    assert.equal(rows('orders').length, 0);
});

// ---------------------------------------------------------------------------
// Managing the rules in the shop
// ---------------------------------------------------------------------------

test('a passcode opens the rules screen; a one-shop passcode manages that shop only', async () => {
    await reset();
    const none = await request(app()).get('/api/store/weins/ordering-rules/manage');
    assert.equal(none.status, 401);

    const u = await request(app()).post('/api/store/weins/ordering-rules/unlock').send({ passcode: '482913', location_id: LOC });
    assert.equal(u.status, 200);
    const t = u.body.token;
    const m = await request(app()).get('/api/store/weins/ordering-rules/manage').set('X-Rules-Token', t);
    assert.equal(m.status, 200);
    assert.equal(m.body.manager.company_wide, true);
    assert.equal(m.body.locations.length, 2);
    assert.ok(Array.isArray(m.body.passcodes));
    assert.ok(!JSON.stringify(m.body).includes('passcode_hash'));

    const save = await request(app()).put('/api/store/weins/ordering-rules/company').set('X-Rules-Token', t)
        .send({ order_limit_on: true, order_limit: '750' });
    assert.equal(save.status, 200);
    assert.equal(rows('ordering_rules')[0].order_limit, 750);
    assert.equal(rows('ordering_rules')[0].updated_by, 'Mike');

    const u2 = await request(app()).post('/api/store/weins/ordering-rules/unlock').send({ passcode: '730564', location_id: LOC2 });
    assert.equal(u2.status, 200);
    const t2 = u2.body.token;
    const m2 = await request(app()).get('/api/store/weins/ordering-rules/manage').set('X-Rules-Token', t2);
    assert.equal(m2.body.locations.length, 1);
    assert.equal(m2.body.passcodes, null);
    assert.equal((await request(app()).put('/api/store/weins/ordering-rules/company').set('X-Rules-Token', t2).send({ hold_on: true })).status, 403);
    assert.equal((await request(app()).put(`/api/store/weins/ordering-rules/locations/${LOC}`).set('X-Rules-Token', t2).send({ hold_on: true })).status, 403);
    assert.equal((await request(app()).put(`/api/store/weins/ordering-rules/locations/${LOC2}`).set('X-Rules-Token', t2).send({ hold_on: true })).status, 200);
    assert.equal((await request(app()).post('/api/store/weins/ordering-rules/passcodes').set('X-Rules-Token', t2).send({ name: 'x', passcode: '204815' })).status, 403);

    // Switching a passcode off ends every session it opened.
    const off = await request(app()).put(`/api/store/weins/ordering-rules/passcodes/${SHOP2}`).set('X-Rules-Token', t).send({ is_active: false });
    assert.equal(off.status, 200);
    assert.equal((await request(app()).get('/api/store/weins/ordering-rules/manage').set('X-Rules-Token', t2)).status, 401);
});

test('passcodes: each needs a name, a real code, and must not repeat another live one', async () => {
    await reset();
    const t = (await request(app()).post('/api/store/weins/ordering-rules/unlock').send({ passcode: '482913', location_id: LOC })).body.token;
    const add = (b) => request(app()).post('/api/store/weins/ordering-rules/passcodes').set('X-Rules-Token', t).send(b);
    assert.equal((await add({ name: '', passcode: '205816' })).status, 400);
    assert.equal((await add({ name: 'Front office', passcode: '123456' })).status, 400);
    assert.equal((await add({ name: 'Front office', passcode: '1234' })).status, 400);
    assert.equal((await add({ name: 'Front office', passcode: '482913' })).status, 409);
    assert.equal((await add({ name: 'mike', passcode: '205816' })).status, 409);
    const ok = await add({ name: 'Front office', passcode: '205816', location_id: LOC });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.passcode.location_id, LOC);
    assert.ok(!('passcode_hash' in ok.body.passcode));
    assert.ok(rows('approval_passcodes').find(p => p.name === 'Front office').passcode_hash.startsWith('scrypt1$'));
});

test('items: a whole category can be marked as needing a manager, and a shop sees the rule state', async () => {
    await reset();
    const t = (await request(app()).post('/api/store/weins/ordering-rules/unlock').send({ passcode: '482913', location_id: LOC })).body.token;
    const r = await request(app()).post('/api/store/weins/ordering-rules/items').set('X-Rules-Token', t)
        .send({ category: 'Misc', requires_approval: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.changed, 2);
    assert.equal(rows('products').filter(p => p.requires_approval).length, 3);

    const s = await request(app()).get(`/api/store/weins/ordering-rules/status?location_id=${LOC}`);
    assert.equal(s.status, 200);
    assert.equal(s.body.any_on, false);
    assert.equal(s.body.has_passcodes, true);
});

// ---------------------------------------------------------------------------
// The console
// ---------------------------------------------------------------------------

test('console: CHC sets the rules, adds the first passcode, and order-desk cannot change them', async () => {
    await reset({ passcodes: false });
    const base = `/api/admin/companies/${CO}/ordering-rules`;
    const g = await request(app()).get(base);
    assert.equal(g.status, 200);
    assert.equal(g.body.passcodes.length, 0);
    assert.equal(g.body.locations.length, 2);

    assert.equal((await request(app()).put(base + '/company').send({ order_limit_on: true, order_limit: 500 })).status, 200);
    assert.equal((await request(app()).put(`${base}/locations/${LOC2}`).send({ order_limit: 250 })).status, 200);
    const add = await request(app()).post(base + '/passcodes').send({ name: 'Mike', passcode: '482913' });
    assert.equal(add.status, 201);

    const g2 = await request(app()).get(base);
    const shop2 = g2.body.locations.find(l => l.id === LOC2);
    assert.equal(shop2.effective.order_limit.on, true);
    assert.equal(shop2.effective.order_limit.amount, 250);
    assert.ok(rows('audit_log').some(a => a.action === 'approval_passcode_added'));
    assert.ok(!JSON.stringify(rows('audit_log')).includes('482913'));

    admin = { id: 'a2', role: 'order_desk', name: 'Desk' };
    assert.equal((await request(app()).put(base + '/company').send({ hold_on: true })).status, 403);
});
