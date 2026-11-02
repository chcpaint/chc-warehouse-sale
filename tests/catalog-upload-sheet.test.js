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

// ---- Any layout: the preview says how the file was read, and a person can correct it ----

const csvFile = (name, text) => ({ originalname: name, buffer: Buffer.from(text) });

test('an unfamiliar supplier layout is read and the preview shows how', async () => {
    reset();
    global.__TEST_FILE__ = csvFile('assured-3m.csv', 'Part Number,Description,List Price,Your Net\n05916,"3M Tape, 3/4 in",4.50,3.10\n02012,3M Filler Gallon,29.99,19.99\n');
    const res = await request(app).post(`/api/admin/companies/${CO}/catalog-upload`).send({ dry_run: '1', vendor: '3M' });
    assert.equal(res.status, 200);
    assert.equal(res.body.inserted, 2);
    assert.equal(res.body.errors, 0);
    const mi = res.body.mapping_info;
    assert.deepEqual(mi.mapping, { sku: 0, name: 1, price: 3, previous_price: 2 });
    assert.equal(mi.columns[3].header, 'Your Net');
    assert.equal(mi.preview.length, 2);
    assert.equal(fake.db.products.length, 1, 'preview writes nothing');
});

test('rows pushed right by stray commas are realigned and imported', async () => {
    reset();
    global.__TEST_FILE__ = csvFile('x.csv', 'SKU,Name,Price\nA1,Tape, masking, wide,3.69\nA2,Filler,4.99\n');
    const res = await request(app).post(`/api/admin/companies/${CO}/catalog-upload`).send({ vendor: '3M' });
    assert.equal(res.status, 200);
    assert.equal(res.body.errors, 0);
    assert.equal(res.body.mapping_info.repaired, 1);
    assert.equal(fake.db.products.find(p => p.sku === 'A1').price, 3.69);
    assert.equal(fake.db.products.find(p => p.sku === 'A1').name, 'Tape, masking, wide');
});

test('when the price column cannot be found it asks (422) and returns the columns to choose from', async () => {
    reset();
    global.__TEST_FILE__ = csvFile('x.csv', 'SKU,Name,List Price\nA1,Thing one,call\nA2,Thing two,ask\n');
    const res = await request(app).post(`/api/admin/companies/${CO}/catalog-upload`).send({ dry_run: '1' });
    assert.equal(res.status, 422);
    assert.equal(res.body.needs_mapping, true);
    assert.match(res.body.error, /price/);
    assert.equal(res.body.mapping_info.columns.length, 3);
    assert.equal(res.body.mapping_info.preview.length, 2);
    assert.equal(fake.db.products.length, 1);
});

test('the person\'s column choices (column_map) decide what is imported', async () => {
    reset();
    global.__TEST_FILE__ = csvFile('x.csv', 'Code,Label,Amt A,Amt B\nA1,Thing one,10.00,3.69\nA2,Thing two,20.00,4.99\n');
    const res = await request(app).post(`/api/admin/companies/${CO}/catalog-upload`)
        .send({ vendor: '3M', column_map: JSON.stringify({ sku: 0, name: 1, price: 3, previous_price: null }) });
    assert.equal(res.status, 200);
    assert.equal(fake.db.products.find(p => p.sku === 'A2').price, 4.99);
    assert.equal(res.body.mapping_info.sources.price, 'manual');
    const audit = fake.db.audit_log.find(a => a.action === 'catalog_uploaded');
    assert.ok(audit, 'the upload is logged');
});

test('bad column_map or header_row input is refused, not guessed at', async () => {
    reset();
    for (const body of [{ column_map: '{not json' }, { column_map: JSON.stringify({ price: -1 }) }, { column_map: JSON.stringify({ price: 'abc' }) }, { header_row: 'x' }, { header_row: '-3' }]) {
        const res = await request(app).post(`/api/admin/companies/${CO}/catalog-upload`).send({ dry_run: '1', ...body });
        assert.equal(res.status, 400, JSON.stringify(body));
    }
});

test('the heading line can be set by hand', async () => {
    reset();
    global.__TEST_FILE__ = csvFile('x.csv', 'Report for March\nA1,Thing one is here,3.69\nA2,Thing two is here,4.99\n');
    const res = await request(app).post(`/api/admin/companies/${CO}/catalog-upload`).send({ dry_run: '1', header_row: '0' });
    assert.equal(res.status, 200);
    assert.equal(res.body.mapping_info.header_row, 0);
    assert.equal(res.body.inserted, 2);
});

// ---- AccountEdge "new items" import: no headings, every price $0.00 ------------------------

function newItemsCsv() {
    const row = (sku, name, cat) => `${sku},${name},B,S,I,11800,41000,51000,,${name},X,${cat},,,,,,3M,,HST,,1,0,0,$0.00,,HST,,1,0,0,0,0,0,N,$0.00,,,3M,0,Kilogram,,N,0,N,,N,N,0,days`;
    return [row('MMM02604', '3M Softback Sanding Sponge Fine', 'Abrasives/Masking'), row('MMM00344', '3M Yellow Spreader 3x4', 'Misc'),
            row('MMM04903', '3M Plastic Contour Sheet', 'Glues/Metal/Bumper'), row('MMM08693', '3M Auto Glass Urethane Adhesive 310mL', 'Glues/Metal/Bumper')].join('\n') + '\n';
}

test('a new-items file with no prices: new parts are added "price on request" for an employee to price, known parts untouched', async () => {
    reset();
    global.__TEST_FILE__ = csvFile('3M_New_Items_Import.csv', newItemsCsv());
    const prev = await request(app).post(`/api/admin/companies/${CO}/catalog-upload`).send({ dry_run: '1', vendor: '3M' });
    assert.equal(prev.status, 200);
    assert.equal(prev.body.rows_read, 4);
    assert.equal(prev.body.mapping_info.no_price, true);
    assert.equal(prev.body.inserted, 3, 'three new parts');
    assert.equal(prev.body.added_unpriced, 3);
    assert.equal(prev.body.errors, 0);
    assert.equal(fake.db.products.length, 1, 'preview writes nothing');

    const res = await request(app).post(`/api/admin/companies/${CO}/catalog-upload`).send({ vendor: '3M' });
    assert.equal(res.status, 200);
    const by = sku => fake.db.products.find(p => p.sku === sku);
    assert.equal(by('MMM02604').price, 0);
    assert.equal(by('MMM02604').price_on_request, true, 'unpriced, not free');
    assert.equal(by('MMM02604').brand, '3M');
    assert.equal(by('MMM02604').name, '3M Softback Sanding Sponge Fine');
    assert.equal(by('MMM00344').price, 2.99, 'a part the shop already has keeps its own price');
    assert.equal(fake.db.products.length, 4);

    // Running the same file again must not create anything twice.
    const again = await request(app).post(`/api/admin/companies/${CO}/catalog-upload`).send({ vendor: '3M' });
    assert.equal(again.body.inserted, 0);
    assert.equal(fake.db.products.length, 4);
});

test('optionally, new parts with no price in the file take the master list price', async () => {
    reset();
    fake.db.item_library = [{ id: 'l1', sku_key: 'MMM02604', brand: '3M', list_price: 6.5 }];
    global.__TEST_FILE__ = csvFile('3M_New_Items_Import.csv', newItemsCsv());
    const res = await request(app).post(`/api/admin/companies/${CO}/catalog-upload`).send({ vendor: '3M', price_from_master: '1' });
    assert.equal(res.body.priced_from_master, 1);
    const p = fake.db.products.find(x => x.sku === 'MMM02604');
    assert.equal(p.price, 6.5);
    assert.equal(p.price_on_request, false);
    assert.equal(fake.db.products.find(x => x.sku === 'MMM04903').price_on_request, true);
});

// ---- Renamed / duplicate / new-number review ------------------------------------------------

const PRICED = rows => 'SKU,Name,Price\n' + rows.map(r => r.join(',')).join('\n') + '\n';

test('a part the manufacturer re-worded (same part number) is a rename, never a second product; its price is untouched', async () => {
    reset();
    global.__TEST_FILE__ = csvFile('x.csv', PRICED([['MMM00344', '3M Yellow Spreader 3 x 4 inch (new)', '']]));
    const prev = await request(app).post(`/api/admin/companies/${CO}/catalog-upload`).send({ dry_run: '1' });
    assert.equal(prev.body.renamed, 1);
    assert.equal(prev.body.review[0].type, 'renamed');
    assert.equal(prev.body.review[0].old_name, '3M Yellow Spreader 3x4');
    assert.equal(fake.db.products[0].name, '3M Yellow Spreader 3x4', 'preview writes nothing');
    await request(app).post(`/api/admin/companies/${CO}/catalog-upload`).send({});
    assert.equal(fake.db.products.length, 1);
    assert.equal(fake.db.products[0].name, '3M Yellow Spreader 3 x 4 inch (new)');
    assert.equal(fake.db.products[0].price, 2.99);
    const audit = fake.db.audit_log.find(a => a.action === 'catalog_uploaded');
    assert.ok(JSON.stringify(audit).includes('3M Yellow Spreader 3x4'), 'old name is kept in the log');
});

test('a rename can be declined, and then the old name stays (even when the file carries a new price)', async () => {
    reset();
    global.__TEST_FILE__ = csvFile('x.csv', PRICED([['MMM00344', 'Totally different words', '3.50']]));
    await request(app).post(`/api/admin/companies/${CO}/catalog-upload`).send({ decisions: { MMM00344: 'skip' } });
    assert.equal(fake.db.products[0].name, '3M Yellow Spreader 3x4');
    assert.equal(fake.db.products[0].price, 3.5, 'the price change still applies');
});

test('part numbers that differ only in punctuation are the same part', async () => {
    reset();
    global.__TEST_FILE__ = csvFile('x.csv', PRICED([['MMM-00344', '3M Yellow Spreader 3x4', '3.10']]));
    const res = await request(app).post(`/api/admin/companies/${CO}/catalog-upload`).send({});
    assert.equal(res.body.inserted, 0);
    assert.equal(fake.db.products.length, 1);
    assert.equal(fake.db.products[0].sku, 'MMM00344', 'the stored part number is not rewritten');
    assert.equal(fake.db.products[0].price, 3.1);
});

test('the same wording under a NEW part number is held for a decision, not added twice', async () => {
    reset();
    global.__TEST_FILE__ = csvFile('x.csv', PRICED([['MMM90001', '3M Yellow Spreader 3x4', '']]));
    const prev = await request(app).post(`/api/admin/companies/${CO}/catalog-upload`).send({ dry_run: '1' });
    assert.equal(prev.body.held, 1);
    assert.equal(prev.body.inserted, 0);
    const r = prev.body.review[0];
    assert.equal(r.type, 'possible_duplicate');
    assert.equal(r.action, 'hold');
    assert.equal(r.matches[0].sku, 'MMM00344');
    await request(app).post(`/api/admin/companies/${CO}/catalog-upload`).send({});
    assert.equal(fake.db.products.length, 1, 'held means nothing is written');
});

test('...and the person can add it anyway, skip it, or say the manufacturer changed the part number', async () => {
    for (const [choice, expect] of [['add', 2], ['skip', 1], ['replace_sku', 1]]) {
        reset();
        global.__TEST_FILE__ = csvFile('x.csv', PRICED([['MMM90001', '3M Yellow Spreader 3x4', '']]));
        const res = await request(app).post(`/api/admin/companies/${CO}/catalog-upload`).send({ decisions: JSON.stringify({ MMM90001: choice }) });
        assert.equal(res.status, 200, choice);
        assert.equal(fake.db.products.length, expect, choice);
        if (choice === 'replace_sku') {
            assert.equal(fake.db.products[0].sku, 'MMM90001', 'the existing product now carries the new part number');
            assert.equal(fake.db.products[0].price, 2.99, 'its price is untouched');
        }
        if (choice === 'add') assert.equal(fake.db.products.find(p => p.sku === 'MMM90001').price_on_request, true);
    }
});

test('items that differ in size or grit are different items, however alike the wording', async () => {
    reset();
    fake.db.products.push({ id: 'p-80', company_id: CO, sku: 'MMM31361', name: '3M Cubitron II Hookit Abrasive Disc P80 3in', brand: '3M', price: 1, is_active: true });
    global.__TEST_FILE__ = csvFile('x.csv', PRICED([['MMM31362', '3M Cubitron II Hookit Abrasive Disc P120 3in', '']]));
    const res = await request(app).post(`/api/admin/companies/${CO}/catalog-upload`).send({ dry_run: '1' });
    assert.equal(res.body.held, 0);
    assert.equal(res.body.inserted, 1);
});

test('the same part number twice in one file is imported once and counted', async () => {
    reset();
    global.__TEST_FILE__ = csvFile('x.csv', PRICED([['A1', 'Alpha thing one', '1.00'], ['a-1', 'Alpha thing one again', '2.00']]));
    const res = await request(app).post(`/api/admin/companies/${CO}/catalog-upload`).send({});
    assert.equal(res.body.file_duplicates, 1);
    assert.equal(fake.db.products.filter(p => /^A/i.test(p.sku)).length, 1);
});

test('a rename arriving in a price-less file still renames (name only)', async () => {
    reset();
    global.__TEST_FILE__ = { originalname: 'n.csv', buffer: Buffer.from('MMM00344,3M Yellow Spreader Wide 3x4,B,S,I,1,2,3,,x,X,Misc,,,,,,3M,,HST,,1,0,0,$0.00\nMMM55555,Brand new item name here,B,S,I,1,2,3,,x,X,Misc,,,,,,3M,,HST,,1,0,0,$0.00\n') };
    const res = await request(app).post(`/api/admin/companies/${CO}/catalog-upload`).send({ vendor: '3M' });
    assert.equal(res.status, 200);
    assert.equal(fake.db.products.find(p => p.sku === 'MMM00344').name, '3M Yellow Spreader Wide 3x4');
    assert.equal(fake.db.products.find(p => p.sku === 'MMM00344').price, 2.99);
    assert.equal(fake.db.products.find(p => p.sku === 'MMM55555').price_on_request, true);
});

test('bad decisions are refused', async () => {
    reset();
    for (const decisions of ['{nope', JSON.stringify({ A: 'delete-everything' }), JSON.stringify(['add'])]) {
        const res = await request(app).post(`/api/admin/companies/${CO}/catalog-upload`).send({ dry_run: '1', decisions });
        assert.equal(res.status, 400);
    }
});

test('a price heading over words still stops and asks, it is not treated as "no prices"', async () => {
    reset();
    global.__TEST_FILE__ = csvFile('x.csv', 'SKU,Name,Price\nA1,Thing one is here,call\nA2,Thing two is here,ask\n');
    const res = await request(app).post(`/api/admin/companies/${CO}/catalog-upload`).send({ dry_run: '1' });
    assert.equal(res.status, 422);
});
