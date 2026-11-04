/**
 * tests/storefront-brand-filter.test.js
 *
 * The storefront brand drop-down: every brand is listed however large the catalogue
 * (the database caps one read at 1,000 rows), and the PPG lines EHP, OneChoice and
 * Shopline are offered beside the brands and filter to their items.
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


const CO = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';

let n = 0;
const item = (o) => ({ id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, company_id: CO,
    price: 10, price_on_request: false, is_active: true, category: 'Paint', ...o });

function load(products) {
    fake = createFakeSupabase({
        companies: [{ id: CO, name: 'Assured', slug: 'test', is_active: true, settings: {} }],
        company_locations: [],
        products
    });
    authCompany = { id: CO, name: 'Assured', slug: 'test' };
}
function app() { const a = express(); a.use(express.json()); a.use('/api/store', storefront); return a; }
const get = (q = '') => request(app()).get('/api/store/test/products' + q);

test('EHP, OneChoice and Shopline are listed when the catalogue has them, filed under PPG', async () => {
    load([
        item({ brand: '3M', name: 'Disc', sku: 'MMM1' }),
        item({ brand: 'PPG', name: 'EHP Toner 100', sku: 'E100' }),
        item({ brand: 'PPG', name: 'OneChoice Clear', sku: 'OC1' }),
        item({ brand: 'PPG', name: 'Shopline Primer', sku: 'SL1' }),
        item({ brand: 'PPG', name: 'Deltron Base', sku: 'D1' })
    ]);
    const res = await get();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.filters.brands, ['3M', 'EHP', 'OneChoice', 'PPG', 'Shopline']);
});

test('a line that no item belongs to is not listed', async () => {
    load([item({ brand: '3M', name: 'Disc', sku: 'MMM1' })]);
    const res = await get();
    assert.deepEqual(res.body.filters.brands, ['3M']);
});

test('choosing a line shows its items whatever brand they are filed under', async () => {
    load([
        item({ brand: 'PPG', name: 'OneChoice Clear', sku: 'OC1' }),
        item({ brand: 'PPG', name: 'One Choice Hardener', sku: 'OC2' }),
        item({ brand: 'OneChoice', name: 'Plain name', sku: 'OC3' }),
        item({ brand: 'PPG', name: 'Deltron Base', sku: 'D1' }),
        item({ brand: '3M', name: 'Disc', sku: 'MMM1' })
    ]);
    const res = await get('?brand=OneChoice');
    assert.deepEqual(res.body.products.map(p => p.sku).sort(), ['OC1', 'OC2', 'OC3']);
});

test('EHP matches a part number that starts with EHP', async () => {
    load([
        item({ brand: 'PPG', name: 'Toner', sku: 'EHP-3350' }),
        item({ brand: 'PPG', name: 'Deltron Base', sku: 'D1' })
    ]);
    const res = await get('?brand=EHP');
    assert.deepEqual(res.body.products.map(p => p.sku), ['EHP-3350']);
});

test('an ordinary brand still filters by exact brand', async () => {
    load([
        item({ brand: 'PPG', name: 'EHP Toner', sku: 'E1' }),
        item({ brand: 'PPG', name: 'Deltron Base', sku: 'D1' }),
        item({ brand: '3M', name: 'Disc', sku: 'M1' })
    ]);
    const res = await get('?brand=PPG');
    assert.deepEqual(res.body.products.map(p => p.sku).sort(), ['D1', 'E1']);
});

test('a line filter can be combined with the search box', async () => {
    load([
        item({ brand: 'PPG', name: 'Shopline Primer Grey', sku: 'SL1' }),
        item({ brand: 'PPG', name: 'Shopline Primer White', sku: 'SL2' })
    ]);
    const res = await get('?brand=Shopline&search=white');
    assert.deepEqual(res.body.products.map(p => p.sku), ['SL2']);
});

test('lines never reach another company\'s items', async () => {
    load([
        item({ brand: 'PPG', name: 'OneChoice Clear', sku: 'OC1' }),
        item({ company_id: OTHER, brand: 'PPG', name: 'OneChoice Other', sku: 'OC9' })
    ]);
    const res = await get('?brand=OneChoice');
    assert.deepEqual(res.body.products.map(p => p.sku), ['OC1']);
});

test('every brand is listed on a catalogue larger than one 1,000-row read', async () => {
    const rows = [];
    for (let i = 0; i < 1500; i++) rows.push(item({ brand: 'Alpha', name: `A ${i}`, sku: `A${i}` }));
    rows.push(item({ brand: 'Zebra Coatings', name: 'Late brand', sku: 'Z1' }));
    load(rows);
    fake.db.__maxRows = 1000;   // behave like the real database: 1,000 rows per request
    const res = await get();
    assert.deepEqual(res.body.filters.brands, ['Alpha', 'Zebra Coatings']);
});

test('a real brand named like a line is folded into the line, once', async () => {
    load([item({ brand: 'EHP', name: 'Toner', sku: 'E1' }), item({ brand: 'PPG', name: 'EHP Toner 2', sku: 'E2' })]);
    const res = await get();
    assert.deepEqual(res.body.filters.brands, ['EHP', 'PPG']);
    const filtered = await get('?brand=EHP');
    assert.deepEqual(filtered.body.products.map(p => p.sku).sort(), ['E1', 'E2']);
});
