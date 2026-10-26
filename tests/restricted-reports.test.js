/**
 * tests/restricted-reports.test.js
 *
 * "Who is ordering" as a fixed drop-down for shops on the shared access code
 * (company_locations.orderer_names, migration 046).
 *
 * The drop-down is a convenience in the browser. The properties worth defending
 * are the ones a browser cannot enforce:
 *
 *   - a hand-built request cannot put any other name on an order
 *   - a shop WITHOUT a list orders exactly as before (typed name)
 *   - the match is forgiving (case, spacing) but the stored name is always the
 *     configured spelling, so reports group one person once
 *   - a signed-in individual keeps their own account name, drop-down or not
 *   - before the migration has been run, nobody is locked out of ordering
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



const CO      = '11111111-1111-4111-8111-111111111111';
const OTHER_CO = '99999999-9999-4999-8999-999999999999';
const LOC_YM  = '33333333-3333-4333-8333-333333333331';
const LOC_N7  = '33333333-3333-4333-8333-333333333332';
const USER    = '66666666-6666-4666-8666-666666666666';

function seed(settings, otherSettings = {}) {
    const o = (id, location_id, who, total) => ({ id, company_id: CO, order_number: 'N' + id, contact_name: who, location_id, location: location_id === LOC_YM ? 'York Mills' : 'North Seven', status: 'pending', total, subtotal: total, tax: 0, created_at: new Date().toISOString(), items: [] });
    return createFakeSupabase({
        companies: [
            { id: CO, name: "Louie's", slug: 'louies', is_active: true, settings },
            { id: OTHER_CO, name: 'Other', slug: 'other', is_active: true, settings: otherSettings }
        ],
        company_locations: [
            { id: LOC_YM, company_id: CO, name: 'York Mills', is_active: true },
            { id: LOC_N7, company_id: CO, name: 'North Seven', is_active: true }
        ],
        orders: [o('1', LOC_YM, 'Bav Mehan', 100), o('2', LOC_N7, 'Julio Mendez', 200), o('3', LOC_YM, 'Kartik Mehan', 50)]
    });
}

function reset(settings, user) {
    fake = seed(settings);
    authCompany = { id: CO, name: "Louie's", slug: 'louies' };
    authUser = user || null;
}

const app = () => { const a = express(); a.use(express.json()); a.use('/api/store', storefront); return a; };
const reports = (qs = '') => request(app()).get('/api/store/louies/reports/orders' + qs);
const ON = { users: { enabled: true, require_individual_login: false }, restricted_reports: { enabled: true } };

test('module off: reports behave exactly as before, shared code included', async () => {
    reset({});
    const res = await reports();
    assert.equal(res.status, 200);
    assert.equal(res.body.orders.length, 3);
});

test('module on: the shared access code gets no reports', async () => {
    reset(ON);
    const res = await reports();
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'reports_need_account');
});

test('module on: an owner tied to York Mills sees York Mills only', async () => {
    reset(ON, { id: USER, name: 'Bav Mehan', email: 'bav@example.invalid', role: 'owner', location_id: LOC_YM });
    const res = await reports();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.orders.map(o => o.contact_name).sort(), ['Bav Mehan', 'Kartik Mehan']);
});

test('module on: asking for North Seven in the query does not get past the location', async () => {
    reset(ON, { id: USER, name: 'Bav Mehan', email: 'bav@example.invalid', role: 'owner', location_id: LOC_YM });
    const res = await reports('?location_id=' + LOC_N7);
    assert.equal(res.status, 200);
    assert.ok(res.body.orders.every(o => o.location_id === LOC_YM), 'a query string must not widen what a person may see');
});

test('module on: an owner with no location sees every location', async () => {
    reset(ON, { id: USER, name: 'Louie', email: 'louie@example.invalid', role: 'owner', location_id: null });
    const res = await reports();
    assert.equal(res.status, 200);
    assert.equal(res.body.orders.length, 3);
});

test('another company is not affected by Louie\'s setting', async () => {
    fake = seed(ON, {});
    authCompany = { id: OTHER_CO, name: 'Other', slug: 'other' };
    authUser = null;
    const res = await request(app()).get('/api/store/other/reports/orders');
    assert.equal(res.status, 200);
});
