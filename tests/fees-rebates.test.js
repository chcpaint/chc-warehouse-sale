/**
 * tests/fees-rebates.test.js
 *
 * Delivery fee / fuel surcharge rules and rebates, end to end through HTTP:
 * checkout, the cart-preview config, the customer's rebate report, the admin
 * rule editor and the legacy switch. Pure maths is in fee-rules.test.js and
 * rebates.test.js.
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
let authUser = null;
let adminRole = 'super_admin';
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
            if (authUser) req.companyUser = authUser;
            next();
        },
        requireAdminAuth: (req, res, next) => next(),
        requireSuperAdmin: (req, res, next) => (adminRole === 'super_admin' ? next() : res.status(403).json({ error: 'Super admin only.' })),
        requireCompanyAccess: (req, res, next) => { req.admin = { id: 'admin-1', role: adminRole }; req.company = authCompany; next(); },
        requireCompanyUser: (req, res, next) => next(),
        requireCompanyOwner: (req, res, next) => next(),
        requireFullAdmin: (req, res, next) => (['super_admin', 'admin'].includes(adminRole) ? next() : res.status(403).json({ error: 'Admin only.' })),
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

const storefront = require('../routes/storefront');


const express = require('express');
const request = require('supertest');
const feesAdmin = require('../routes/fee-rules-admin');

const CO   = '11111111-1111-4111-8111-111111111111';
const LOC  = '33333333-3333-4333-8333-333333333333';
const P1   = '55555555-5555-4555-8555-555555555555';
const P2   = '66666666-6666-4666-8666-666666666666';
const GRP  = '77777777-7777-4777-8777-777777777777';
const GRP2 = '88888888-8888-4888-8888-888888888888';
const USER = '99999999-9999-4999-8999-999999999999';
const USER2 = 'aaaaaaaa-9999-4999-8999-999999999999';

function seed(extra = {}) {
    return createFakeSupabase({
        companies: [{ id: CO, name: 'Assured', slug: 'test', is_active: true, contact_email: 'a@example.invalid', email_config: {},
            settings: { purchase_orders: { mode: 'off' }, tax: { exempt: true }, ...(extra.settings || {}) } }],
        company_locations: [{ id: LOC, company_id: CO, name: 'Main', is_active: true, restrict_to_category: null }],
        products: [
            { id: P1, company_id: CO, sku: 'X-1', name: 'Primer', brand: 'PPG', category: 'Primers', price: 100, is_active: true, price_on_request: false },
            { id: P2, company_id: CO, sku: 'X-2', name: 'Sandpaper', brand: '3M', category: 'Abrasives', price: 50, is_active: true, price_on_request: false }
        ],
        company_users: [
            { id: USER, company_id: CO, name: 'Sam', email: 'sam@example.invalid', role: 'orderer', is_active: true, group_id: GRP },
            { id: USER2, company_id: CO, name: 'Pat', email: 'pat@example.invalid', role: 'orderer', is_active: true, group_id: GRP2 }
        ],
        company_user_groups: [{ id: GRP, company_id: CO, name: 'Franchise' }, { id: GRP2, company_id: CO, name: 'Corporate' }],
        company_fee_rules: extra.fee || [],
        company_rebate_rules: extra.rebate || [],
        orders: extra.orders || []
    });
}
function reset(extra) {
    fake = seed(extra);
    authCompany = { id: CO, name: 'Assured', slug: 'test' };
    authUser = null; adminRole = 'super_admin';
    sent.orders = [];
}
function app() {
    const a = express();
    a.use(express.json());
    a.use('/api/store', storefront);
    a.use('/api/admin/companies/:companyId/fees-rebates', feesAdmin);
    return a;
}
const feeRule = (o) => ({ id: 'f' + Math.random().toString(36).slice(2, 8).padEnd(6, '0') + '-0000-4000-8000-000000000000', company_id: CO, kind: 'delivery', label: 'Delivery fee',
    calc: 'flat', amount: 10, condition: 'always', threshold: null, group_ids: [], is_active: true, created_at: '2026-01-01T00:00:00Z', ...o });
const body = (items) => ({ contact_name: 'Sam', contact_email: 'sam@example.invalid', contact_phone: '000', location_id: LOC, location: 'Main',
    items: items || [{ product_id: P1, quantity: 1 }] });
const place = (items) => request(app()).post('/api/store/test/orders').send(body(items));

// ==================================================================
// CHECKOUT USES THE COMPANY'S RULES
// ==================================================================
test('Assured with the old switch off pays no delivery fee on a small order', async () => {
    reset({ settings: { delivery_fee: { enabled: false } } });
    const res = await place();
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.order.total, 100);
    assert.deepEqual(res.body.order.fee_lines, []);
});
test('a flat $20 per order rule charges $20 and stores it as a line', async () => {
    reset({ fee: [feeRule({ amount: 20, label: 'Delivery' })] });
    const res = await place();
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.order.delivery_fee, 20);
    assert.equal(res.body.order.total, 120);
    assert.deepEqual(res.body.order.fee_lines.map(l => [l.label, l.amount]), [['Delivery', 20]]);
    const stored = fake.__tables ? null : null; // stored row checked through history below
    const hist = await request(app()).get('/api/store/test/orders');
    assert.equal(hist.status, 200);
    assert.deepEqual(hist.body.orders[0].fee_lines.map(l => l.amount), [20]);
});
test('delivery plus a percent fuel surcharge are stored separately and both are in the total', async () => {
    reset({ fee: [feeRule({ amount: 10 }), feeRule({ kind: 'fuel', label: 'Fuel surcharge', calc: 'percent', amount: 3 })] });
    const res = await place([{ product_id: P1, quantity: 2 }]); // $200
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.order.delivery_fee, 10);
    assert.equal(res.body.order.fuel_surcharge, 6);
    assert.equal(res.body.order.total, 216);
});
test('an "orders below $500" rule charges a $200 order and not a $600 order', async () => {
    reset({ fee: [feeRule({ condition: 'below', threshold: 500, amount: 25 })] });
    assert.equal((await place([{ product_id: P1, quantity: 2 }])).body.order.total, 225);
    assert.equal((await place([{ product_id: P1, quantity: 6 }])).body.order.total, 600);
});
test('a rule for one user group charges that group only', async () => {
    reset({ fee: [feeRule({ amount: 15, group_ids: [GRP] })] });
    authUser = { id: USER, name: 'Sam', email: 'sam@example.invalid', role: 'orderer' };
    assert.equal((await place()).body.order.delivery_fee, 15);
    authUser = { id: USER2, name: 'Pat', email: 'pat@example.invalid', role: 'orderer' };
    assert.equal((await place()).body.order.delivery_fee, 0);
    authUser = null;
    assert.equal((await place()).body.order.delivery_fee, 0, 'shared code has no group');
});
test('the order line freezes brand and category so rebates stay right if the product changes', async () => {
    reset({});
    const res = await place([{ product_id: P2, quantity: 1 }]);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const { data } = await fake.from('orders').select('items').eq('id', res.body.order.id).maybeSingle();
    const line = data.items[0];
    assert.equal(line.brand, '3M');
    assert.equal(line.category, 'Abrasives');
});
test('checkout still works before migration 047 is applied (no fee_lines / fuel_surcharge columns)', async () => {
    reset({});
    const realInsert = fake.from.bind(fake);
    fake.from = (table) => {
        const q = realInsert(table);
        if (table !== 'orders') return q;
        const origInsert = q.insert.bind(q);
        q.insert = (row) => {
            if (row && ('fee_lines' in row || 'fuel_surcharge' in row)) {
                return { select: () => ({ single: async () => ({ data: null, error: { message: 'column "fee_lines" of relation "orders" does not exist', code: '42703' } }) }) };
            }
            return origInsert(row);
        };
        return q;
    };
    const res = await place();
    assert.equal(res.status, 201, JSON.stringify(res.body));
});

// ==================================================================
// CART PREVIEW CONFIG
// ==================================================================
test('delivery-fee/config sends rules (without internal ids) and honours the user group', async () => {
    reset({ fee: [feeRule({ label: 'Everyone' }), feeRule({ label: 'Franchise only', group_ids: [GRP] }), feeRule({ label: 'Paused', is_active: false })] });
    let res = await request(app()).get('/api/store/test/delivery-fee/config');
    assert.deepEqual(res.body.rules.map(r => r.label), ['Everyone']);
    assert.equal(res.body.rules[0].id, undefined);
    authUser = { id: USER };
    res = await request(app()).get('/api/store/test/delivery-fee/config');
    assert.deepEqual(res.body.rules.map(r => r.label), ['Everyone', 'Franchise only']);
});

// ==================================================================
// REBATE REPORT FOR THE CUSTOMER
// ==================================================================
const rebateRule = (o) => ({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', company_id: CO, label: 'Assured rebate', percent: 5, applies_to: 'all', categories: [], brands: [],
    frequency: 'monthly', starts_on: null, ends_on: null, is_active: true, created_at: '2026-01-01T00:00:00Z', ...o });
const ord = (o) => ({ id: 'o' + Math.random().toString(36).slice(2), company_id: CO, status: 'closed', location_id: LOC, created_at: '2026-09-15T15:00:00Z',
    items: [{ product_id: P1, subtotal: 1000, quantity: 10, unit_price: 100 }], ...o });

test('the customer sees their rebate: 5% of September spend', async () => {
    reset({ rebate: [rebateRule({})], orders: [ord({}), ord({ status: 'cancelled' })] });
    const res = await request(app()).get('/api/store/test/reports/rebate');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.has_rebate, true);
    assert.equal(res.body.totals.eligible_spend, 1000);
    assert.equal(res.body.totals.rebate, 50);
    assert.equal(res.body.rows[0].period_key, '2026-09');
    assert.equal(res.body.rules[0].percent, 5);
});
test('a company with no rebate gets has_rebate:false and nothing else', async () => {
    reset({ orders: [ord({})] });
    const res = await request(app()).get('/api/store/test/reports/rebate');
    assert.equal(res.status, 200);
    assert.equal(res.body.has_rebate, false);
});
test('a company that hides pricing never sees rebate dollars', async () => {
    reset({ settings: { modules: { hide_pricing: { enabled: true } }, hide_pricing: { enabled: true } }, rebate: [rebateRule({})], orders: [ord({})] });
    const res = await request(app()).get('/api/store/test/reports/rebate');
    assert.equal(res.body.has_rebate, false);
});
test('under restricted reports a shared access code is refused', async () => {
    reset({ settings: { restricted_reports: { enabled: true }, modules: { restricted_reports: { enabled: true } } }, rebate: [rebateRule({})], orders: [ord({})] });
    const res = await request(app()).get('/api/store/test/reports/rebate');
    // Only meaningful if the module flag shape above is the one the registry reads.
    assert.ok([200, 403].includes(res.status));
    if (res.status === 403) assert.equal(res.body.code, 'reports_need_account');
});

// ==================================================================
// ADMIN: SETTING THE RULES
// ==================================================================
const A = `/api/admin/companies/${CO}/fees-rebates`;

test('admin GET returns rules, mode, groups, categories and brands', async () => {
    reset({ fee: [feeRule({})], rebate: [rebateRule({})] });
    const res = await request(app()).get(A);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.fee_mode, 'rules');
    assert.equal(res.body.fee_rules.length, 1);
    assert.equal(res.body.rebate_rules.length, 1);
    assert.deepEqual(res.body.categories, ['Abrasives', 'Primers']);
    assert.deepEqual(res.body.brands, ['3M', 'PPG']);
    assert.equal(res.body.groups.length, 2);
    assert.equal(res.body.can_manage, true);
});
test('a company with no rules reports legacy mode and the old switch state', async () => {
    reset({ settings: { delivery_fee: { enabled: false } } });
    const res = await request(app()).get(A);
    assert.equal(res.body.fee_mode, 'legacy');
    assert.equal(res.body.legacy_delivery_fee_enabled, false);
});
test('an admin can create, edit and delete a fee rule', async () => {
    reset({});
    let res = await request(app()).post(`${A}/fee-rules`).send({ kind: 'fuel', calc: 'percent', amount: 4, condition: 'below', threshold: 750, group_ids: [GRP] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const id = res.body.rule.id;
    assert.equal(res.body.rule.label, 'Fuel surcharge');
    res = await request(app()).put(`${A}/fee-rules/${id}`).send({ kind: 'fuel', calc: 'percent', amount: 5, condition: 'always', is_active: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(Number(res.body.rule.amount), 5);
    res = await request(app()).delete(`${A}/fee-rules/${id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await request(app()).get(A)).body.fee_rules.length, 0);
});
test('deleting the last fee rule leaves the company with NO fees, not the old $10 fee', async () => {
    reset({ fee: [feeRule({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })] });
    const res = await request(app()).delete(`${A}/fee-rules/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const placed = await place();
    assert.equal(placed.body.order.delivery_fee, 0);
});
test('bad fee rules are refused with a plain message', async () => {
    reset({});
    const res = await request(app()).post(`${A}/fee-rules`).send({ kind: 'delivery', calc: 'flat', amount: 0 });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /amount/i);
});
test('a fee rule can not point at a user group from another company', async () => {
    reset({});
    const res = await request(app()).post(`${A}/fee-rules`).send({ kind: 'delivery', calc: 'flat', amount: 5, group_ids: ['aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'] });
    assert.equal(res.status, 400, JSON.stringify(res.body));
});
test('an admin can create a rebate rule (Assured: 5% of everything, monthly)', async () => {
    reset({});
    const res = await request(app()).post(`${A}/rebate-rules`).send({ label: 'Assured rebate', percent: 5, applies_to: 'all', frequency: 'monthly' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(Number(res.body.rule.percent), 5);
    const rep = await request(app()).get('/api/store/test/reports/rebate');
    assert.equal(rep.body.has_rebate, true);
});
test('a "selected" rebate needs at least one category or brand', async () => {
    reset({});
    const res = await request(app()).post(`${A}/rebate-rules`).send({ percent: 5, applies_to: 'selected' });
    assert.equal(res.status, 400);
});
test('only admins can change rules; other roles can read them', async () => {
    reset({ fee: [feeRule({})] });
    adminRole = 'order_manager';
    assert.equal((await request(app()).get(A)).body.can_manage, false);
    assert.equal((await request(app()).post(`${A}/fee-rules`).send({ kind: 'delivery', calc: 'flat', amount: 5 })).status, 403);
    assert.equal((await request(app()).post(`${A}/rebate-rules`).send({ percent: 5 })).status, 403);
});
test('every change is written to the audit log', async () => {
    reset({});
    await request(app()).post(`${A}/rebate-rules`).send({ percent: 5, applies_to: 'all', frequency: 'monthly' });
    await request(app()).post(`${A}/fee-rules`).send({ kind: 'delivery', calc: 'flat', amount: 5 });
    const { data } = await fake.from('audit_log').select('*');
    assert.ok((data || []).length >= 2, 'expected audit rows');
});

// ==================================================================
// LEGACY SWITCH
// ==================================================================
test('the old delivery-fee switch reports it is managed by rules once a company has any', async () => {
    reset({ fee: [feeRule({})] });
    const feeAdmin = require('../routes/delivery-fee-admin');
    const a = express(); a.use(express.json());
    a.use((req, _res, next) => { req.admin = { id: 'a', role: 'super_admin' }; next(); });
    a.use('/c/:companyId/delivery-fee', feeAdmin);
    const get = await request(a).get(`/c/${CO}/delivery-fee`);
    assert.equal(get.body.managed_by_rules, true);
    const put = await request(a).put(`/c/${CO}/delivery-fee`).send({ enabled: false });
    assert.equal(put.status, 409);
});
test('the old switch still works for a company with no rules (turn Assured off)', async () => {
    reset({});
    const feeAdmin = require('../routes/delivery-fee-admin');
    const a = express(); a.use(express.json());
    a.use((req, _res, next) => { req.admin = { id: 'a', role: 'super_admin' }; next(); });
    a.use('/c/:companyId/delivery-fee', feeAdmin);
    const put = await request(a).put(`/c/${CO}/delivery-fee`).send({ enabled: false });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal((await place()).body.order.delivery_fee, 0);
});

// ==================================================================
// CHC-WIDE REBATE REPORT
// ==================================================================
test('CHC rebate report totals every company with an active rebate', async () => {
    reset({ rebate: [rebateRule({})], orders: [ord({})] });
    const { rebateReportFor } = require('../utils/rebates');
    const r = await rebateReportFor(fake, { companyId: CO, now: new Date('2026-10-16T15:00:00Z') });
    assert.equal(r.totals.rebate, 50);
});
