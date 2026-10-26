/**
 * tests/catalog-upload-sheet.test.js
 *
 * POST /companies/:id/catalog-upload with a real vendor price sheet end to end:
 * title block above the headings, $ prices, vendor typed into the upload, preview
 * versus apply, new parts added and known parts re-priced.
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.invalid';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'service-key';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { createFakeSupabase } = require('./helpers/fake-supabase');

const ROOT = path.resolve(__dirname, '..');
const fake = createFakeSupabase();

const supabaseProxy = new Proxy({}, {
    get: (_t, prop) => {
        const v = fake[prop];
        return typeof v === 'function' ? v.bind(fake) : v;
    }
});

let authAdmin = null;
const sentInvites = [];

const stubs = {
    [path.join(ROOT, 'utils/supabase.js')]: { supabase: supabaseProxy, supabaseAdmin: supabaseProxy },
    [path.join(ROOT, 'utils/sanitize.js')]: {
        stripHtml: s => String(s === undefined || s === null ? '' : s).replace(/<[^>]*>/g, ''),
        sanitizeObject: o => o,
        isValidUUID: v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '')),
        generateSlug: s => s,
        validateEmail: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || ''))
    },
    [path.join(ROOT, 'utils/email.js')]: {
        sendInvite: async (o) => { sentInvites.push(o); return { sent: true }; },
        sendOrderStatusUpdate: async () => ({ sent: true }),
        sendOrderNoteAdded: async () => ({ sent: true }),
        sendContactNote: async () => ({ sent: true }),
        sendInvoiceReady: async () => ({ sent: true }),
        sendOrderClosed: async () => ({ sent: true })
    },
    [path.join(ROOT, 'middleware/upload.js')]: {
        catalogUpload: { single: () => (req, res, next) => { req.file = global.__TEST_FILE__; next(); } },
        logoUpload: { single: () => (req, res, next) => next() },
        invoiceUpload: { single: () => (req, res, next) => next() }
    },
    [path.join(ROOT, 'utils/payments.js')]: {
        paymentsEnabled: () => false,
        publicPaymentConfig: () => ({ enabled: false }),
        getStripe: () => null
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

const realAuth = require('../middleware/auth');
stubs[path.join(ROOT, 'middleware/auth.js')] = {
    ...realAuth,
    requireAdminAuth: (req, res, next) => {
        if (!authAdmin) return res.status(401).json({ error: 'Admin access denied.' });
        req.admin = authAdmin;
        next();
    },
    requireCompanyAuth: (req, res, next) => res.status(401).json({ error: 'Not authenticated.' })
};

const express = require('express');
const request = require('supertest');
const adminRoutes = require('../routes/admin');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);


const XLSX = require('xlsx');
const CO = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

function sheetBuffer() {
    const grid = [
        [null], ['CHC Wholesale Inc.'], ['1200 Speers Road, Unit 15'], ['Oakville, Ontario'], ['Items List [Summary]'], [''], [''],
        ['', 'Item #', 'Item Name', 'Current Price', 'Item Description'],
        ['', 'MMM00344', '3M Yellow Spreader 3x4', '$3.69', ''],
        ['', 'MMM01160', '3M Short Strand Body Filler Ga', '$79.99', '3M Short Strand Body Filler Ga'],
        ['', 'MMM09999', 'Call for price item', 'call', ''],
        ['', 'MMM02071', '3M Particulate Filter P95', '$15.99', '']
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(grid), 'Sheet1');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function reset() {
    fake.db.companies = [{ id: CO, name: 'Concord Collision Center', slug: 'concord', is_active: true, settings: {} }];
    fake.db.products = [{ id: 'p-existing', company_id: CO, sku: 'MMM00344', name: '3M Yellow Spreader 3x4', brand: '3M', price: 2.99, is_active: true }];
    fake.db.item_library = [];
    fake.db.catalog_uploads = [];
    fake.db.audit_log = [];
    global.__TEST_FILE__ = { originalname: '3Mitems.xlsx', buffer: sheetBuffer() };
    authAdmin = { id: 'bbbbbbbb-cccc-4ddd-8eee-000000000001', email: 'adam@chcpaint.com', name: 'Adam', role: 'super_admin', is_active: true, must_change_password: false };
}

test('a preview of a real vendor sheet reads it, reports each bad line by its Excel row, and writes nothing', async () => {
    reset();
    const res = await request(app).post(`/api/admin/companies/${CO}/catalog-upload`).send({ dry_run: '1', vendor: '3M' });
    assert.equal(res.status, 200);
    assert.equal(res.body.preview, true);
    assert.equal(res.body.rows_read, 4);
    assert.equal(res.body.inserted, 2, 'two parts the shop does not have yet');
    assert.equal(res.body.updated, 1, 'one part it already has');
    assert.equal(res.body.price_changes, 1);
    assert.equal(res.body.sample_changes[0].old_price, 2.99);
    assert.equal(res.body.sample_changes[0].new_price, 3.69);
    assert.equal(res.body.errors, 1);
    assert.equal(res.body.error_details[0].row, 11, 'the "call" price line is row 11 in Excel');
    assert.match(res.body.error_details[0].error, /"call" is not a number/);
    assert.equal(fake.db.products.length, 1, 'a preview must not write');
});

test('applying it adds the new parts under the vendor and re-prices the known one', async () => {
    reset();
    const res = await request(app).post(`/api/admin/companies/${CO}/catalog-upload`).send({ vendor: '3M' });
    assert.equal(res.status, 200);
    assert.equal(res.body.preview, false);
    assert.equal(fake.db.products.length, 3);
    const known = fake.db.products.find(p => p.sku === 'MMM00344');
    assert.equal(known.price, 3.69);
    const added = fake.db.products.find(p => p.sku === 'MMM02071');
    assert.equal(added.brand, '3M');
    assert.equal(added.price, 15.99);
    assert.equal(added.company_id, CO);
});

test('without a vendor the parts are filed as Uncategorized rather than under "Sheet1"', async () => {
    reset();
    await request(app).post(`/api/admin/companies/${CO}/catalog-upload`).send({});
    const added = fake.db.products.find(p => p.sku === 'MMM02071');
    assert.equal(added.brand, 'Uncategorized');
});
