/**
 * tests/product-barcodes.test.js
 *
 * Barcodes on a company's catalogue.
 *
 * These exist because the first version of the uniqueness check used an
 * embedded select that resolved to nothing, so it found no clash and accepted
 * a code already in use. A uniqueness check that silently finds nothing is a
 * uniqueness check that always passes, and it looks identical to a working one
 * in every test that only checks the happy path.
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
let authAdmin = { id: 'aaaaaaaa-1111-4111-8111-111111111111', role: 'super_admin', company_id: null };

const supabaseProxy = new Proxy({}, {
    get: (_t, prop) => {
        const v = fake[prop];
        return typeof v === 'function' ? v.bind(fake) : v;
    }
});

const stubs = {
    [path.join(ROOT, 'utils/supabase.js')]: { supabaseAdmin: supabaseProxy },
    [path.join(ROOT, 'middleware/auth.js')]: {
        requireAdminAuth: (req, res, next) => { req.admin = authAdmin; next(); },
        requireSuperAdmin: (req, res, next) => next(),
        requireCompanyAccess: (req, res, next) => { req.admin = authAdmin; next(); },
        requireFullAdmin: (req, res, next) => next(),
        restrictOrderDesk: (req, res, next) => next(),
        requirePasswordCurrent: (req, res, next) => next(),
        requireOrderAccess: (req, res, next) => next(),
        ORDER_ONLY_ROLES: ['order_desk', 'order_manager']
    },
    [path.join(ROOT, 'utils/sanitize.js')]: {
        stripHtml: s => String(s === undefined || s === null ? '' : s).replace(/<[^>]*>/g, ''),
        sanitizeObject: o => o,
        isValidUUID: v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '')),
        generateSlug: s => s,
        validateEmail: () => true
    },
    [path.join(ROOT, 'utils/recipients.js')]: {
        resolveOrderRecipients: async () => ({ to: [], replyTo: null }), validEmails: l => l
    },
    [path.join(ROOT, 'utils/email.js')]: {
        sendOrderNotification: async () => {}, sendInvoiceReady: async () => {},
        sendOrderClosed: async () => {}, sendLowStockAlert: async () => ({ ok: true }),
        sendInvite: async () => ({ ok: true })
    },
    [path.join(ROOT, 'middleware/upload.js')]: {
        catalogUpload: { single: () => (req, res, next) => next() },
        logoUpload: { single: () => (req, res, next) => next() },
        invoiceUpload: { single: () => (req, res, next) => next() }
    },
    [path.join(ROOT, 'utils/order-scope.js')]: {
        orderScopeIds: async () => null, applyOrderScope: q => q, orderInScope: async () => ({ ok: true })
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
const adminRoutes = require('../routes/admin');

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const DISC  = '33333333-3333-4333-8333-333333333333';
const TAPE  = '44444444-4444-4444-8444-444444444444';
const THEIR = '55555555-5555-4555-8555-555555555555';

function reset() {
    fake = createFakeSupabase({
        companies: [
            { id: CO_A, name: 'Assured Collision', slug: 'assured', is_active: true },
            { id: CO_B, name: 'Bayview Auto Body', slug: 'bayview', is_active: true }
        ],
        products: [
            { id: DISC,  company_id: CO_A, sku: 'MMM09251', name: '3M Hookit Gold Disc', price: 40.99, is_active: true },
            { id: TAPE,  company_id: CO_A, sku: 'MMM06652', name: '3M Yellow Tape', price: 12, is_active: true },
            { id: THEIR, company_id: CO_B, sku: 'MMM09251', name: '3M Hookit Gold Disc', price: 42.50, is_active: true }
        ],
        product_barcodes: [
            { id: 'bc-1', product_id: DISC, barcode: '051131020474', symbology: 'UPC_A', is_primary: true, is_internal: false }
        ],
        audit_log: []
    });
    authAdmin = { id: 'aaaaaaaa-1111-4111-8111-111111111111', role: 'super_admin', company_id: null };
}

function app() {
    const a = express();
    a.use(express.json());
    a.use('/api/admin', adminRoutes);
    return a;
}

const setBarcode = (co, prod, barcode) =>
    request(app()).put(`/api/admin/companies/${co}/products/${prod}/barcode`).send({ barcode });

// ==================================================================

test('the catalogue lists each product with its barcode', async () => {
    reset();
    const res = await request(app()).get(`/api/admin/companies/${CO_A}/products?includeInactive=true`);
    assert.equal(res.status, 200);
    const disc = res.body.products.find(p => p.sku === 'MMM09251');
    const tape = res.body.products.find(p => p.sku === 'MMM06652');
    assert.equal(disc.barcode, '051131020474',
        'the catalogue screen could not show a barcode until this was joined in');
    assert.equal(tape.barcode, null, 'and an item without one has to read as null, not be missing');
});

test('a barcode already on another product in the SAME catalogue is refused', async () => {
    reset();
    const res = await setBarcode(CO_A, TAPE, '051131020474');
    assert.equal(res.status, 409);
    assert.match(res.body.error, /already on MMM09251/);
    assert.equal(fake.db.product_barcodes.filter(b => b.barcode === '051131020474').length, 1,
        'the refusal must not have written anything');
});

test('the same code on a DIFFERENT customer is allowed', async () => {
    reset();
    // Two shops each stock the same 3M part. They each hold their own copy of
    // it at their own price, and the manufacturer's barcode is the same one.
    // Blocking this would make the second shop unable to scan a real product.
    const res = await setBarcode(CO_B, THEIR, '051131020474');
    assert.equal(res.status, 200);
    assert.equal(fake.db.product_barcodes.filter(b => b.barcode === '051131020474').length, 2);
});

test('setting a code twice on the same product is not a clash with itself', async () => {
    reset();
    const res = await setBarcode(CO_A, DISC, '051131020474');
    assert.equal(res.status, 200, 'a product must not be blocked by its own barcode');
});

test('a new code replaces the old one rather than accumulating', async () => {
    reset();
    await setBarcode(CO_A, DISC, '051131066526');
    const codes = fake.db.product_barcodes.filter(b => b.product_id === DISC && b.is_primary);
    assert.equal(codes.length, 1, 'one primary code, or a scan has to choose');
    assert.equal(codes[0].barcode, '051131066526');
});

test('an empty value clears the barcode, and only when sent on purpose', async () => {
    reset();
    const res = await setBarcode(CO_A, DISC, '');
    assert.equal(res.status, 200);
    assert.equal(res.body.barcode, null);
    assert.equal(fake.db.product_barcodes.filter(b => b.product_id === DISC).length, 0);
});

test('junk is refused with a message that says what is acceptable', async () => {
    reset();
    for (const junk of ['ab', 'has spaces', '<script>x</script>']) {
        const res = await setBarcode(CO_A, TAPE, junk);
        assert.equal(res.status, 400, `"${junk}" should not be storable`);
        assert.match(res.body.error, /4–48 characters/);
    }
});

test('a product from another company cannot be reached through this company\'s path', async () => {
    reset();
    const res = await setBarcode(CO_A, THEIR, '051131066526');
    assert.equal(res.status, 404);
    assert.match(res.body.error, /not in this company/);
});

test('symbology is inferred from length rather than guessed', async () => {
    reset();
    await setBarcode(CO_A, TAPE, '051131066526');            // 12
    assert.equal(fake.db.product_barcodes.find(b => b.product_id === TAPE).symbology, 'UPC_A');
    await setBarcode(CO_A, TAPE, '5025427724426');           // 13
    assert.equal(fake.db.product_barcodes.find(b => b.product_id === TAPE).symbology, 'EAN_13');
    await setBarcode(CO_A, TAPE, 'CHC-INTERNAL-01');
    assert.equal(fake.db.product_barcodes.find(b => b.product_id === TAPE).symbology, 'OTHER');
});
