/**
 * tests/cart.test.js
 *
 * The shared storefront cart (migrations/043_shared_cart.sql). A customer
 * reported the bug this exists to close: one staff member built a cart,
 * a teammate logged in to review and submit it, and found it empty — the
 * cart used to live only in that first browser's sessionStorage. These
 * tests exist to prove two different logins under the same company_id see
 * and can edit the exact same cart, plus the ordinary CRUD behaviour
 * around it.
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

// Mutable auth fixtures the requireCompanyAuth stub below reads on every
// request, so a single test can switch "who is signed in" mid-flight —
// exactly how two logins under one account behave in production.
let authCompany = null;
let authCompanyUser = null;

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
            req.companyUser = authCompanyUser;
            next();
        },
        requireAdminAuth: (req, res, next) => next(),
        requireSuperAdmin: (req, res, next) => next(),
        requireCompanyAccess: (req, res, next) => next(),
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
        sendOrderNotification: async () => ({ sent: true }),
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

const CO        = '11111111-1111-4111-8111-111111111111';
const OTHER_CO  = '99999999-9999-4999-8999-999999999999';
const DISC      = '55555555-5555-4555-8555-555555555556';
const PAINT     = '55555555-5555-4555-8555-555555555557';
const OTHER_PROD = '55555555-5555-4555-8555-555555555559';
const EHSAN     = '22222222-2222-4222-8222-222222222221';
const TEAMMATE  = '22222222-2222-4222-8222-222222222222';

function reset() {
    fake = createFakeSupabase({
        companies: [
            { id: CO, name: 'Test Shop', slug: 'test', is_active: true, settings: {} },
            { id: OTHER_CO, name: 'Someone Else', slug: 'other', is_active: true, settings: {} }
        ],
        products: [
            { id: DISC, company_id: CO, sku: 'MMM09251', name: '3M Hookit Gold Disc', brand: '3M',
              category: 'Abrasives', price: 40.99, price_on_request: false, is_active: true },
            { id: PAINT, company_id: CO, sku: '920-121', name: 'Quart Can', brand: 'PPG',
              category: 'Colour', price: 180.75, price_on_request: false, is_active: true },
            { id: OTHER_PROD, company_id: OTHER_CO, sku: 'X-1', name: 'Someone else\'s product',
              brand: 'PPG', category: 'Colour', price: 99, price_on_request: false, is_active: true }
        ]
    });
    authCompany = { id: CO, name: 'Test Shop', slug: 'test' };
    authCompanyUser = { id: EHSAN, name: 'Ehsan', email: 'ehsan@example.invalid', role: 'member', location_id: null };
}

function app() {
    const a = express();
    a.use(express.json());
    a.use('/api/store', storefront);
    return a;
}

const BASE = '/api/store/test/cart';

test('a brand new account has an empty shared cart', async () => {
    reset();
    const res = await request(app()).get(BASE);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items, []);
});

test('adding a product creates a line with quantity 1 and display fields joined in', async () => {
    reset();
    const res = await request(app()).post(`${BASE}/items`).send({ product_id: DISC });
    assert.equal(res.status, 200);
    assert.equal(res.body.item.product_id, DISC);
    assert.equal(res.body.item.quantity, 1);

    const get = await request(app()).get(BASE);
    assert.equal(get.body.items.length, 1);
    assert.equal(get.body.items[0].name, '3M Hookit Gold Disc');
    assert.equal(get.body.items[0].brand, '3M');
    assert.equal(get.body.items[0].sku, 'MMM09251');
    assert.equal(get.body.items[0].price, 40.99);
    assert.equal(get.body.items[0].added_by_name, 'Ehsan');
});

test('adding the same product again bumps the existing line instead of duplicating it', async () => {
    reset();
    await request(app()).post(`${BASE}/items`).send({ product_id: DISC });
    const res = await request(app()).post(`${BASE}/items`).send({ product_id: DISC });
    assert.equal(res.body.item.quantity, 2);

    const get = await request(app()).get(BASE);
    assert.equal(get.body.items.length, 1);
    assert.equal(get.body.items[0].quantity, 2);
});

test('THE BUG: a teammate who logs in separately sees exactly what the first person put in the cart', async () => {
    reset();
    // Ehsan builds the cart.
    await request(app()).post(`${BASE}/items`).send({ product_id: DISC });
    await request(app()).post(`${BASE}/items`).send({ product_id: PAINT });

    // A different login, same company_id -- the customer's teammate,
    // reviewing the order on their own machine.
    authCompanyUser = { id: TEAMMATE, name: 'Teammate', email: 'teammate@example.invalid', role: 'owner', location_id: null };

    const res = await request(app()).get(BASE);
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 2);
    const ids = res.body.items.map(i => i.product_id).sort();
    assert.deepEqual(ids, [DISC, PAINT].sort());
});

test('the shared company login (no individual company_user) sees the same cart too', async () => {
    reset();
    await request(app()).post(`${BASE}/items`).send({ product_id: DISC });

    authCompanyUser = null; // the shared access-code session, not an individual login
    const res = await request(app()).get(BASE);
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].product_id, DISC);
});

test('a teammate editing a line updates it for everyone, and add_by reflects whoever last touched it', async () => {
    reset();
    await request(app()).post(`${BASE}/items`).send({ product_id: DISC }); // Ehsan, qty 1

    authCompanyUser = { id: TEAMMATE, name: 'Teammate', email: 'teammate@example.invalid', role: 'owner', location_id: null };
    const put = await request(app()).put(`${BASE}/items/${DISC}`).send({ quantity: 5 });
    assert.equal(put.status, 200);
    assert.equal(put.body.item.quantity, 5);
    assert.equal(put.body.item.added_by_name, 'Teammate');

    const get = await request(app()).get(BASE);
    assert.equal(get.body.items[0].quantity, 5);
    assert.equal(get.body.items[0].added_by_name, 'Teammate');
});

test('setting quantity to zero removes the line', async () => {
    reset();
    await request(app()).post(`${BASE}/items`).send({ product_id: DISC });
    const res = await request(app()).put(`${BASE}/items/${DISC}`).send({ quantity: 0 });
    assert.equal(res.status, 200);
    assert.equal(res.body.removed, true);

    const get = await request(app()).get(BASE);
    assert.deepEqual(get.body.items, []);
});

test('a quantity over 9999 is refused', async () => {
    reset();
    await request(app()).post(`${BASE}/items`).send({ product_id: DISC });
    const res = await request(app()).put(`${BASE}/items/${DISC}`).send({ quantity: 10000 });
    assert.equal(res.status, 400);

    const get = await request(app()).get(BASE);
    assert.equal(get.body.items[0].quantity, 1); // unchanged
});

test('DELETE one line removes just that product', async () => {
    reset();
    await request(app()).post(`${BASE}/items`).send({ product_id: DISC });
    await request(app()).post(`${BASE}/items`).send({ product_id: PAINT });

    const res = await request(app()).delete(`${BASE}/items/${DISC}`);
    assert.equal(res.status, 200);

    const get = await request(app()).get(BASE);
    assert.equal(get.body.items.length, 1);
    assert.equal(get.body.items[0].product_id, PAINT);
});

test('DELETE the whole cart with product_ids clears only the selected lines', async () => {
    reset();
    await request(app()).post(`${BASE}/items`).send({ product_id: DISC });
    await request(app()).post(`${BASE}/items`).send({ product_id: PAINT });

    const res = await request(app()).delete(BASE).send({ product_ids: [DISC] });
    assert.equal(res.status, 200);

    const get = await request(app()).get(BASE);
    assert.equal(get.body.items.length, 1);
    assert.equal(get.body.items[0].product_id, PAINT);
});

test('DELETE the whole cart with no body clears everything -- the after-checkout case', async () => {
    reset();
    await request(app()).post(`${BASE}/items`).send({ product_id: DISC });
    await request(app()).post(`${BASE}/items`).send({ product_id: PAINT });

    const res = await request(app()).delete(BASE);
    assert.equal(res.status, 200);

    const get = await request(app()).get(BASE);
    assert.deepEqual(get.body.items, []);
});

test('a product belonging to a different company cannot be added', async () => {
    reset();
    const res = await request(app()).post(`${BASE}/items`).send({ product_id: OTHER_PROD });
    assert.equal(res.status, 404);

    const get = await request(app()).get(BASE);
    assert.deepEqual(get.body.items, []);
});

test('a product belonging to a different company cannot be set via PUT either', async () => {
    reset();
    const res = await request(app()).put(`${BASE}/items/${OTHER_PROD}`).send({ quantity: 3 });
    assert.equal(res.status, 404);
});

test('an invalid product id is a 400, not a crash', async () => {
    reset();
    const res = await request(app()).post(`${BASE}/items`).send({ product_id: 'not-a-uuid' });
    assert.equal(res.status, 400);
});

test('a product removed from the catalogue after being carted drops out of the cart silently', async () => {
    reset();
    await request(app()).post(`${BASE}/items`).send({ product_id: DISC });
    fake.db.products = fake.db.products.filter(p => p.id !== DISC);

    const res = await request(app()).get(BASE);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items, []);
});

test('the cart requires an authenticated company like every other storefront route', async () => {
    reset();
    authCompany = null;
    const res = await request(app()).get(BASE);
    assert.equal(res.status, 401);
});
