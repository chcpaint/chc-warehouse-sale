/**
 * tests/orders-delivery-fee.test.js
 *
 * The delivery fee on the order route, exercised through HTTP — the order
 * route always recomputes this itself at submit time (utils/delivery-fee.js
 * has the pure logic tests); this file is where that wiring is checked end
 * to end, the same way tests/orders-tax.test.js checks the tax wiring.
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

function seed(deliveryFeeBlock) {
    return createFakeSupabase({
        companies: [{
            id: CO, name: 'Test Shop', slug: 'test', is_active: true,
            contact_email: 'shop@example.invalid', email_config: {},
            settings: {
                purchase_orders: { mode: 'off' },
                tax: { exempt: true }, // keep totals simple to reason about
                ...(deliveryFeeBlock ? { delivery_fee: deliveryFeeBlock } : {})
            }
        }],
        company_locations: [{ id: LOC, company_id: CO, name: 'Main', is_active: true, restrict_to_category: null }],
        products: [
            { id: PRODUCT, company_id: CO, sku: 'X-1', name: 'Widget', category: 'Misc', price: 100, is_active: true, price_on_request: false },
            { id: PRODUCT2, company_id: CO, sku: 'X-2', name: 'Gadget', category: 'Misc', price: 50, is_active: true, price_on_request: true }
        ]
    });
}

function reset(deliveryFeeBlock) {
    fake = seed(deliveryFeeBlock);
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
    items: items || [{ product_id: PRODUCT, quantity: 1 }]
});

// ==================================================================
// DEFAULT — every company is charged the fee on a small order unless
// configured otherwise
// ==================================================================

test('a $100 order (under $300) with no delivery-fee settings is charged the $10 fee by default', async () => {
    reset(undefined);
    const res = await request(app()).post('/api/store/test/orders').send(body());
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.order.subtotal, 100);
    assert.equal(res.body.order.delivery_fee, 10);
    assert.equal(res.body.order.total, 110);
});

test('an order at $300 or more is not charged the fee', async () => {
    reset(undefined);
    const res = await request(app()).post('/api/store/test/orders')
        .send(body([{ product_id: PRODUCT, quantity: 3 }])); // $300 subtotal
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.order.subtotal, 300);
    assert.equal(res.body.order.delivery_fee, 0);
    assert.equal(res.body.order.total, 300);
});

// ==================================================================
// TURNED OFF FOR THE ACCOUNT
// ==================================================================

test('a company with the fee turned off is never charged it, even on a $1 order', async () => {
    reset({ enabled: false });
    const res = await request(app()).post('/api/store/test/orders').send(body());
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.order.delivery_fee, 0);
    assert.equal(res.body.order.total, res.body.order.subtotal);
});

// ==================================================================
// PRICE-ON-REQUEST INTERACTION
// ==================================================================

test('a price-on-request line does not count toward the $300 threshold — same reasoning as tax', async () => {
    reset(undefined);
    const res = await request(app()).post('/api/store/test/orders')
        .send(body([{ product_id: PRODUCT2, quantity: 1 }])); // $50 listed, but priced at $0 (quoted)
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.order.subtotal, 0);
    assert.equal(res.body.order.delivery_fee, 10);
});

// ==================================================================
// THE CART-PREVIEW CONFIG ENDPOINT
// ==================================================================

test('GET delivery-fee/config reports the default (on) for a company with nothing configured', async () => {
    reset(undefined);
    const res = await request(app()).get('/api/store/test/delivery-fee/config');
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.threshold, 300);
    assert.equal(res.body.fee, 10);
});

test('GET delivery-fee/config reflects the account being turned off', async () => {
    reset({ enabled: false });
    const res = await request(app()).get('/api/store/test/delivery-fee/config');
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, false);
});

test('GET delivery-fee/config requires the same company auth every other storefront route does', async () => {
    reset(undefined);
    authCompany = null;
    const res = await request(app()).get('/api/store/test/delivery-fee/config');
    assert.equal(res.status, 401);
});
