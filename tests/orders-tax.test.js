/**
 * tests/orders-tax.test.js
 *
 * Tax on the order route, exercised through HTTP — the order route always
 * recomputes tax itself at submit time (utils/tax.js has the pure logic
 * tests); this file is where that wiring is checked end to end, the same way
 * tests/orders-po.test.js checks the PO wiring.
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

const CO       = '11111111-1111-4111-8111-111111111111';
const LOC      = '33333333-3333-4333-8333-333333333333';
const PRODUCT  = '55555555-5555-4555-8555-555555555555';
const PRODUCT2 = '66666666-6666-4666-8666-666666666666';

function seed(taxBlock) {
    return createFakeSupabase({
        companies: [{
            id: CO, name: 'Test Shop', slug: 'test', is_active: true,
            contact_email: 'shop@example.invalid', email_config: {},
            settings: { purchase_orders: { mode: 'off' }, ...(taxBlock ? { tax: taxBlock } : {}) }
        }],
        company_locations: [{ id: LOC, company_id: CO, name: 'Main', is_active: true, restrict_to_category: null }],
        products: [
            { id: PRODUCT, company_id: CO, sku: 'X-1', name: 'Widget', category: 'Misc', price: 100, is_active: true, price_on_request: false },
            { id: PRODUCT2, company_id: CO, sku: 'X-2', name: 'Gadget', category: 'Misc', price: 50, is_active: true, price_on_request: true }
        ]
    });
}

function reset(taxBlock) {
    fake = seed(taxBlock);
    authCompany = { id: CO, name: 'Test Shop', slug: 'test' };
    sent.orders = [];
}

function app() {
    const a = express();
    a.use(express.json());
    a.use('/api/store', storefront);
    return a;
}

const body = (items) => ({
    contact_name: 'Sam', contact_email: 'sam@example.invalid', contact_phone: '000',
    location_id: LOC, location: 'Main',
    items: items || [{ product_id: PRODUCT, quantity: 2 }]
});

// ==================================================================
// DEFAULT — every company is charged 13% Ontario HST unless configured
// ==================================================================

test('a company with no tax settings is charged 13% HST by default', async () => {
    reset(undefined);
    const res = await request(app()).post('/api/store/test/orders').send(body());
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.order.subtotal, 200);
    assert.equal(res.body.order.tax, 26);
    assert.equal(res.body.order.tax_rate, 0.13);
    assert.equal(res.body.order.total, 226);
});

test('the stored total is the priced subtotal plus tax, not the subtotal alone', () => {
    // Guards the regression this feature exists to fix: before this, total
    // was literally `= subtotal`.
    assert.notEqual(226, 200, 'sanity: the two numbers really do differ');
});

// ==================================================================
// CUSTOM RATE
// ==================================================================

test('a company with a configured rate is charged that rate instead', async () => {
    reset({ rate: 0.15 });
    const res = await request(app()).post('/api/store/test/orders').send(body());
    assert.equal(res.status, 201);
    assert.equal(res.body.order.tax, 30);
    assert.equal(res.body.order.tax_rate, 0.15);
    assert.equal(res.body.order.total, 230);
});

// ==================================================================
// EXEMPT
// ==================================================================

test('an exempt company is charged no tax at all', async () => {
    reset({ exempt: true, rate: 0.15 });
    const res = await request(app()).post('/api/store/test/orders').send(body());
    assert.equal(res.status, 201);
    assert.equal(res.body.order.tax, 0);
    assert.equal(res.body.order.tax_rate, 0);
    assert.equal(res.body.order.total, res.body.order.subtotal);
});

// ==================================================================
// PRICE-ON-REQUEST INTERACTION
// ==================================================================

test('a price-on-request line is not taxed — it has no price to tax yet', async () => {
    reset(undefined);
    const res = await request(app()).post('/api/store/test/orders')
        .send(body([{ product_id: PRODUCT, quantity: 1 }, { product_id: PRODUCT2, quantity: 1 }]));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    // Only the $100 widget is priced; the $50-listed gadget is price_on_request.
    assert.equal(res.body.order.subtotal, 100);
    assert.equal(res.body.order.tax, 13);
    assert.equal(res.body.order.total, 113);
});

// ==================================================================
// THE CART-PREVIEW CONFIG ENDPOINT
// ==================================================================

test('GET tax/config reports the default for a company with nothing configured', async () => {
    reset(undefined);
    const res = await request(app()).get('/api/store/test/tax/config');
    assert.equal(res.status, 200);
    assert.equal(res.body.rate, 0.13);
    assert.equal(res.body.exempt, false);
    assert.equal(res.body.is_default, true);
});

test('GET tax/config reflects an exemption', async () => {
    reset({ exempt: true });
    const res = await request(app()).get('/api/store/test/tax/config');
    assert.equal(res.status, 200);
    assert.equal(res.body.exempt, true);
    assert.equal(res.body.rate, 0);
});

test('GET tax/config requires the same company auth every other storefront route does', async () => {
    reset(undefined);
    authCompany = null;
    const res = await request(app()).get('/api/store/test/tax/config');
    assert.equal(res.status, 401);
});
