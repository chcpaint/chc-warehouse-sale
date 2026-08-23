/**
 * tests/orders-po.test.js
 *
 * The order route, exercised through HTTP.
 *
 * WHY THIS FILE EXISTS: a missing import reached production. `resolveOrderPo`
 * was called in routes/storefront.js and never imported, which is a runtime
 * ReferenceError — invisible to `node --check`, invisible to the unit suite
 * because nothing tested the order route at all, and invisible to the boot
 * probe because that only checks a route is mounted, not that it runs. Every
 * order 500'd until the live harness found it.
 *
 * One request through this route would have caught it in a second. So now
 * there is one.
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
        requireCompanyAccess: (req, res, next) => next()
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
const LOC     = '33333333-3333-4333-8333-333333333333';
const PRODUCT = '55555555-5555-4555-8555-555555555555';

function seed(poBlock) {
    return createFakeSupabase({
        companies: [{
            id: CO, name: 'Test Shop', slug: 'test', is_active: true,
            contact_email: 'shop@example.invalid', email_config: {},
            settings: poBlock ? { purchase_orders: poBlock } : {}
        }],
        company_locations: [{ id: LOC, company_id: CO, name: 'Main', is_active: true, restrict_to_category: null }],
        products: [{ id: PRODUCT, company_id: CO, sku: 'X-1', name: 'Widget', category: 'Misc', price: 10, is_active: true, price_on_request: false }],
        company_po_sequences: []
    });
}

function reset(poBlock) {
    fake = seed(poBlock);
    authCompany = { id: CO, name: 'Test Shop', slug: 'test' };
    sent.orders = [];
}

function app() {
    const a = express();
    a.use(express.json());
    a.use('/api/store', storefront);
    return a;
}

const body = (po) => ({
    contact_name: 'Sam', contact_email: 'sam@example.invalid', contact_phone: '000',
    location_id: LOC, location: 'Main',
    items: [{ product_id: PRODUCT, quantity: 2 }],
    ...(po === undefined ? {} : { po_number: po })
});

// ==================================================================

test('the order route actually runs — no missing imports', async () => {
    // The plainest possible assertion, and the one that was missing. A 500 here
    // means the module references something it never imported.
    reset({ mode: 'manual' });
    const res = await request(app()).post('/api/store/test/orders').send(body('PO-1'));
    assert.notEqual(res.status, 500, `order route threw: ${JSON.stringify(res.body)}`);
    assert.equal(res.status, 201, JSON.stringify(res.body));
});

test('the PO config endpoint runs', async () => {
    reset({ mode: 'manual' });
    const res = await request(app()).get('/api/store/test/po/config');
    assert.notEqual(res.status, 500, `config route threw: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.mode, 'manual');
    assert.equal(res.body.required, true);
});

// ------------------------------------------------------------------
// The three modes, through the real route
// ------------------------------------------------------------------

test('manual: an order without a PO is refused', async () => {
    reset({ mode: 'manual' });
    const res = await request(app()).post('/api/store/test/orders').send(body(''));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /purchase order/i);
});

test('manual: the typed number is stored, normalised', async () => {
    reset({ mode: 'manual' });
    const res = await request(app()).post('/api/store/test/orders').send(body('  po-77 '));
    assert.equal(res.status, 201);
    assert.equal(fake.db.orders[0].po_number, 'PO-77');
    assert.equal(fake.db.orders[0].po_source, 'manual');
});

test('off: an order goes through with no PO at all', async () => {
    reset({ mode: 'off' });
    const res = await request(app()).post('/api/store/test/orders').send(body());
    assert.equal(res.status, 201);
    assert.equal(fake.db.orders[0].po_number, null);
    assert.equal(fake.db.orders[0].po_source, 'none');
});

test('off: a stray typed number is not stored', async () => {
    reset({ mode: 'off' });
    await request(app()).post('/api/store/test/orders').send(body('SOMETHING'));
    assert.equal(fake.db.orders[0].po_number, null,
        'storing it would leave a PO on a company that does not use them');
});

test('a company with no PO settings behaves exactly as before — PO required', async () => {
    reset(null);
    const res = await request(app()).post('/api/store/test/orders').send(body(''));
    assert.equal(res.status, 400,
        'the default must not silently change ordering for existing customers');
});

test('generated: refuses cleanly when no sequence is configured', async () => {
    reset({ mode: 'generated' });
    const res = await request(app()).post('/api/store/test/orders').send(body());
    assert.equal(res.status, 409);
    assert.match(res.body.error, /not set up/i);
    assert.equal(fake.db.orders.length, 0, 'no order should exist without its number');
});

test('generated: allocates, formats and stores the number', async () => {
    reset({ mode: 'generated' });
    fake.db.company_po_sequences.push({
        company_id: CO, prefix: 'QAT', next_number: 41, pad_width: 5, use_check_digit: true
    });

    const res = await request(app()).post('/api/store/test/orders').send(body());
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.order.po_number, /^QAT-00041-\d$/);
    assert.equal(res.body.order.po_source, 'generated');
});

test('generated: a typed number cannot override the sequence', async () => {
    reset({ mode: 'generated' });
    fake.db.company_po_sequences.push({
        company_id: CO, prefix: 'QAT', next_number: 1, pad_width: 5, use_check_digit: true
    });
    const res = await request(app()).post('/api/store/test/orders').send(body('MINE'));
    assert.notEqual(res.body.order?.po_number, 'MINE');
});

test('the branch email shows the number that was actually issued', async () => {
    reset({ mode: 'generated' });
    fake.db.company_po_sequences.push({
        company_id: CO, prefix: 'QAT', next_number: 5, pad_width: 5, use_check_digit: true
    });
    const res = await request(app()).post('/api/store/test/orders').send(body('IGNORED'));
    assert.equal(sent.orders.length, 1);
    assert.equal(sent.orders[0].poNumber, res.body.order.po_number,
        'the branch must see the issued number, not what was typed');
});

test('the confirmation carries the PO back so the shop can record it', async () => {
    reset({ mode: 'generated' });
    fake.db.company_po_sequences.push({
        company_id: CO, prefix: 'QAT', next_number: 9, pad_width: 5, use_check_digit: true
    });
    const res = await request(app()).post('/api/store/test/orders').send(body());
    assert.ok(res.body.order.po_number, 'without this the shop never sees the number');
    assert.equal(res.body.order.po_source, 'generated');
});
