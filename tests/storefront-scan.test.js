/**
 * tests/storefront-scan.test.js
 *
 * GET /api/store/:slug/products/lookup — scanning a barcode straight into the
 * ordering cart. Unlike refinishAI Inventory's own /lookup, this one exists
 * for every customer whether or not the inventory module is on, because
 * placing an order by scanning a shelf is an ordering behaviour, not a stock
 * one.
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
const LOC       = '33333333-3333-4333-8333-333333333333';
const LOC_LOCKED = '33333333-3333-4333-8333-333333333334';
const DISC      = '55555555-5555-4555-8555-555555555555';
const PAINT     = '55555555-5555-4555-8555-555555555556';
const SHARED_A  = '55555555-5555-4555-8555-555555555557';
const SHARED_B  = '55555555-5555-4555-8555-555555555558';
const OTHER_PROD = '55555555-5555-4555-8555-555555555559';

function reset() {
    fake = createFakeSupabase({
        companies: [
            { id: CO, name: 'Test Shop', slug: 'test', is_active: true, settings: {} },
            { id: OTHER_CO, name: 'Someone Else', slug: 'other', is_active: true, settings: {} }
        ],
        company_locations: [
            { id: LOC, company_id: CO, name: 'Main', is_active: true, restrict_to_category: null },
            { id: LOC_LOCKED, company_id: CO, name: 'Booth Only', is_active: true, restrict_to_category: 'Equip/Filter/Booth' }
        ],
        products: [
            { id: DISC, company_id: CO, sku: 'MMM09251', name: '3M Hookit Gold Disc', brand: '3M',
              category: 'Abrasives', price: 40.99, price_on_request: false, is_active: true },
            { id: PAINT, company_id: CO, sku: '920-121', name: 'Quart Can', brand: 'PPG',
              category: 'Colour', price: 180.75, price_on_request: false, is_active: true },
            { id: SHARED_A, company_id: CO, sku: 'DUP-A', name: 'Shared code A', brand: 'PPG',
              category: 'Colour', price: 10, price_on_request: false, is_active: true },
            { id: SHARED_B, company_id: CO, sku: 'DUP-B', name: 'Shared code B', brand: 'PPG',
              category: 'Colour', price: 12, price_on_request: false, is_active: true },
            { id: OTHER_PROD, company_id: OTHER_CO, sku: 'MMM09251', name: 'Someone else\'s disc',
              brand: '3M', category: 'Abrasives', price: 99, price_on_request: false, is_active: true }
        ],
        product_barcodes: [
            { id: 'bc-1', product_id: DISC, barcode: '0051131020474' },
            { id: 'bc-2', product_id: SHARED_A, barcode: '0000000000001' },
            { id: 'bc-2b', product_id: SHARED_B, barcode: '0000000000001' },
            { id: 'bc-3', product_id: OTHER_PROD, barcode: '0099999999999' }
        ]
    });
    authCompany = { id: CO, name: 'Test Shop', slug: 'test' };
}

function app() {
    const a = express();
    a.use(express.json());
    a.use('/api/store', storefront);
    return a;
}

const S = '/api/store/test/products/lookup';

test('a scanned barcode finds its product', async () => {
    reset();
    const res = await request(app()).get(`${S}?code=051131020474`);
    assert.equal(res.status, 200);
    assert.equal(res.body.matched_by, 'barcode');
    assert.equal(res.body.product.id, DISC);
    assert.equal(res.body.product.sku, 'MMM09251');
});

test('a UPC-A and its zero-padded EAN-13 form find the same product', async () => {
    reset();
    const short = await request(app()).get(`${S}?code=51131020474`);
    assert.equal(short.status, 200);
    assert.equal(short.body.product.id, DISC);
});

test('typing the part number works the same as scanning it', async () => {
    reset();
    const res = await request(app()).get(`${S}?code=920-121`);
    assert.equal(res.status, 200);
    assert.equal(res.body.matched_by, 'sku');
    assert.equal(res.body.product.id, PAINT);
});

test('an unknown code is a plain 404, not an error', async () => {
    reset();
    const res = await request(app()).get(`${S}?code=000000000000`);
    assert.equal(res.status, 404);
    assert.match(res.body.error, /No product matches/);
});

test('two products sharing one code come back as candidates to choose from', async () => {
    reset();
    const res = await request(app()).get(`${S}?code=0000000000001`);
    assert.equal(res.status, 300);
    assert.equal(res.body.ambiguous, true);
    assert.equal(res.body.candidates.length, 2);
});

test('a location with a category lock only offers what that location may order', async () => {
    reset();
    // MMM09251 is Abrasives; Booth Only is locked to Equip/Filter/Booth.
    const res = await request(app()).get(`${S}?code=051131020474&location_id=${LOC_LOCKED}`);
    assert.equal(res.status, 404);
    assert.match(res.body.error, /Equip\/Filter\/Booth/);
});

test('a location with no lock is unaffected', async () => {
    reset();
    const res = await request(app()).get(`${S}?code=051131020474&location_id=${LOC}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.product.id, DISC);
});

test('another company\'s product with the same barcode is invisible', async () => {
    reset();
    const res = await request(app()).get(`${S}?code=099999999999`);
    // Only this company's own catalogue is searched -- the shared barcode on
    // another tenant's product must never leak across the tenant boundary.
    assert.equal(res.status, 404);
});

test('no code at all is a 400, not a crash', async () => {
    reset();
    const res = await request(app()).get(S);
    assert.equal(res.status, 400);
});

test('lookup requires an authenticated company like every other storefront route', async () => {
    reset();
    authCompany = null;
    const res = await request(app()).get(`${S}?code=051131020474`);
    assert.equal(res.status, 401);
});
