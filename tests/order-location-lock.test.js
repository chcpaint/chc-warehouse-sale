/**
 * tests/order-location-lock.test.js
 *
 * Found by the full QA run: an individual login locked to one shop could post an
 * order for a sibling shop by sending that shop's location_id. The shared access
 * code carries no location and must stay unrestricted.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { createFakeSupabase } = require('./helpers/fake-supabase');

const ROOT = path.resolve(__dirname, '..');
let fake = createFakeSupabase();
let authCompany = null;
let authCompanyUser = null;
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
            if (authCompanyUser) req.companyUser = authCompanyUser;
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
const LOC_A   = '33333333-3333-4333-8333-333333333333';
const LOC_B   = '44444444-4444-4444-8444-444444444444';
const PRODUCT = '55555555-5555-4555-8555-555555555555';
const USER    = '66666666-6666-4666-8666-666666666666';

function reset(user) {
    fake = createFakeSupabase({
        companies: [{ id: CO, name: 'Two Shop Co', slug: 'two', is_active: true, contact_email: 'x@example.invalid', email_config: {}, settings: { purchase_orders: { mode: 'off' } } }],
        company_locations: [
            { id: LOC_A, company_id: CO, name: 'Shop A', is_active: true, restrict_to_category: null },
            { id: LOC_B, company_id: CO, name: 'Shop B', is_active: true, restrict_to_category: null }
        ],
        company_users: [{ id: USER, company_id: CO, name: 'Pat', email: 'pat@example.invalid', role: 'member', is_active: true, location_id: LOC_A }],
        products: [{ id: PRODUCT, company_id: CO, sku: 'X-1', name: 'Widget', category: 'Misc', price: 10, is_active: true, price_on_request: false }],
        company_po_sequences: []
    });
    authCompany = { id: CO, name: 'Two Shop Co', slug: 'two' };
    authCompanyUser = user || null;
}
function app() { const a = express(); a.use(express.json()); a.use('/api/store', storefront); return a; }
const body = (loc) => ({ contact_name: 'x', contact_email: 'x@example.invalid', contact_phone: '0', location_id: loc, items: [{ product_id: PRODUCT, quantity: 1 }] });

test('a person locked to one shop cannot place an order for another shop', async () => {
    reset({ id: USER, name: 'Pat', email: 'pat@example.invalid', location_id: LOC_A });
    const res = await request(app()).post('/api/store/two/orders').send(body(LOC_B));
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(fake.db.orders.length, 0, 'no order may be created');
});

test('a person locked to one shop can order for their own shop, and the lock fills a missing location', async () => {
    reset({ id: USER, name: 'Pat', email: 'pat@example.invalid', location_id: LOC_A });
    let res = await request(app()).post('/api/store/two/orders').send(body(LOC_A));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    res = await request(app()).post('/api/store/two/orders').send(body(undefined));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(fake.db.orders.every(o => o.location_id === LOC_A));
});

test('the shared access code (no person, no location) still picks any shop — Assured sign-in is unchanged', async () => {
    reset(null);
    const res = await request(app()).post('/api/store/two/orders').send(body(LOC_B));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(fake.db.orders[0].location_id, LOC_B);
});
