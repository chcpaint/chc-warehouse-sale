/**
 * tests/master-table.test.js
 *
 * The master table import. The tests that matter here are not "does it load a
 * row" — they are the ways a load can quietly corrupt the catalogue:
 *
 *   - a blank cell read as "delete what we have"
 *   - two part numbers collapsing into one because punctuation was stripped
 *   - one barcode ending up on two parts, so a scan cannot tell them apart
 *   - a case barcode stored as if it identified a single item
 *   - an overwrite with no record of what was there before
 *   - a preview that writes
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
        requireSuperAdmin: (req, res, next) => {
            if (authAdmin.role !== 'super_admin') {
                return res.status(403).json({ error: 'Super admin access required.' });
            }
            req.admin = authAdmin; next();
        },
        requireAdminAuth: (req, res, next) => { req.admin = authAdmin; next(); },
        requireCompanyAccess: (req, res, next) => { req.admin = authAdmin; next(); }
    },
    [path.join(ROOT, 'utils/sanitize.js')]: {
        stripHtml: s => String(s === undefined || s === null ? '' : s).replace(/<[^>]*>/g, ''),
        sanitizeObject: o => o,
        isValidUUID: v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '')),
        generateSlug: s => s,
        validateEmail: () => true
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
const XLSX = require('xlsx');
const masterTable = require('../routes/master-table');
const { skuKey, barcodeLevel, parseWorkbook } = masterTable._internals;

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const PROD_A = '33333333-3333-4333-8333-333333333333';

const HEADER = ['Item Number (Part #)', 'Item Name', 'Product Category', 'Sub-Category',
                'Brand', 'Vendor Item Number', 'MSRP (Selling Price)', 'UPC', 'Case Qty', 'Notes'];

/** Build an xlsx buffer the way the real upload arrives. */
function workbook(rows, header = HEADER, sheet = 'CHC Product List') {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    XLSX.utils.book_append_sheet(wb, ws, sheet);
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function app() {
    const a = express();
    // server.js applies this app-wide; the router relies on it.
    a.use(express.json());
    a.use('/master', masterTable);
    return a;
}

function reset(seed = {}) {
    fake = createFakeSupabase({
        item_library: [], item_library_imports: [], item_library_changes: [],
        company_item_aliases: [], v_product_master: [], v_catalogue_alignment: [],
        companies: [
            { id: CO_A, name: 'Assured Collision', slug: 'assured', is_active: true },
            { id: CO_B, name: 'Bayview Auto Body', slug: 'bayview', is_active: true }
        ],
        products: [
            { id: PROD_A, company_id: CO_A, sku: 'YELTAPE34', name: 'Yellow tape 3/4', price: 12, is_active: true }
        ],
        audit_log: [],
        ...seed
    });
    authAdmin = { id: 'aaaaaaaa-1111-4111-8111-111111111111', role: 'super_admin', company_id: null };
}

const upload = (buf, query = '') =>
    request(app()).post(`/master/import${query}`).attach('file', buf, 'master.xlsx');

// ==================================================================
// Normalisation — the thing everything else depends on
// ==================================================================

test('the same part written three ways is one key', () => {
    assert.equal(skuKey('MMM-06652'), 'MMM06652');
    assert.equal(skuKey('mmm 06652'), 'MMM06652');
    assert.equal(skuKey('MMM06652'), 'MMM06652');
});

test('a 14-digit code is a case, not an each', () => {
    assert.equal(barcodeLevel('051131020474'), 'each');   // UPC-A
    assert.equal(barcodeLevel('5025427724426'), 'each');  // EAN-13
    assert.equal(barcodeLevel('10776960887131'), 'case'); // GTIN-14
    assert.equal(barcodeLevel('4703483650'), 'unknown');  // 10 digits — neither
    assert.equal(barcodeLevel('1077696007781-5'), 'unknown');
    assert.equal(barcodeLevel(''), null);
});

// ==================================================================
// Reading the file
// ==================================================================

test('the header does not have to be the first row', async () => {
    const buf = workbook([
        ['CHC Product Database', '', '', '', '', '', '', '', '', ''],
        [], HEADER,
        ['MMM09251', '3M Disc', 'Abrasives', null, '3M', null, '40.99', '051131020474', '1', null]
    ], ['', '', '', '', '', '', '', '', '', '']);
    const parsed = parseWorkbook(buf, 'x.xlsx');
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0].sku, 'MMM09251');
});

test('a file with no recognisable header is refused with a message a person can act on', async () => {
    reset();
    const buf = workbook([['a', 'b']], ['Widget', 'Thing']);
    const res = await upload(buf);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /header row/i);
    assert.match(res.body.error, /Item Number/);
});

test('"not available" and "n/a" are absences, not values', async () => {
    const buf = workbook([
        ['MMM33377', '3M Roloc Disc', 'Abrasives', null, '3M', null, '75.49', 'not available', 'n/a', 'none']
    ]);
    const parsed = parseWorkbook(buf, 'x.xlsx');
    assert.equal(parsed.rows[0].barcode, null, 'a literal "not available" stored as a barcode is worse than nothing');
    assert.equal(parsed.rows[0].case_qty, null);
    assert.equal(parsed.rows[0].notes, null);
});

test('a differently-worded header still maps (UPC/Barcode, Matched Part #)', async () => {
    const buf = workbook(
        [['MMM30701', '3M Purple Sheet', '71.49', '051131020474']],
        ['Matched Part #', 'Item Name', 'MSRP', 'UPC/Barcode']);
    const parsed = parseWorkbook(buf, 'x.xlsx');
    assert.equal(parsed.rows[0].sku, 'MMM30701');
    assert.equal(parsed.rows[0].list_price, 71.49);
    assert.equal(parsed.rows[0].barcode, '051131020474');
});

// ==================================================================
// Preview
// ==================================================================

test('a preview writes nothing to the library', async () => {
    reset();
    const buf = workbook([
        ['MMM09251', '3M Disc', 'Abrasives', null, '3M', null, '40.99', '051131020474', '1', null]
    ]);
    const res = await upload(buf);
    assert.equal(res.status, 200);
    assert.equal(res.body.applied, false);
    assert.equal(res.body.summary.to_create, 1);
    assert.equal(fake.db.item_library.length, 0, 'a dry run that writes is not a dry run');
});

test('a preview is still recorded, so what was considered is on the record', async () => {
    reset();
    await upload(workbook([['A1', 'Thing', null, null, null, null, '5', null, null, null]]));
    assert.equal(fake.db.item_library_imports.length, 1);
    assert.equal(fake.db.item_library_imports[0].applied, false);
});

// ==================================================================
// Applying — the corruption cases
// ==================================================================

test('a blank cell never erases a value we already hold', async () => {
    reset({
        item_library: [{
            id: 'lib-1', sku: 'MMM09251', sku_key: 'MMM09251', name: '3M Disc',
            brand: '3M', barcode: '051131020474', list_price: 40.99, case_qty: 1, category: 'Abrasives'
        }]
    });
    // Same part, but the spreadsheet has lost the barcode and the case qty.
    const buf = workbook([
        ['MMM09251', '3M Hookit Gold Disc 80D', 'Abrasives', null, '3M', null, '42.99', '', '', null]
    ]);
    const res = await upload(buf, '?apply=true');
    assert.equal(res.status, 200);

    const row = fake.db.item_library[0];
    assert.equal(row.barcode, '051131020474', 'an empty barcode cell means the file does not know one, not delete it');
    assert.equal(row.case_qty, 1);
    assert.equal(row.name, '3M Hookit Gold Disc 80D', 'but a value that IS present wins');
    assert.equal(row.list_price, 42.99);
});

test('every overwrite is recorded with what it replaced', async () => {
    reset({
        item_library: [{ id: 'lib-1', sku: 'MMM09251', sku_key: 'MMM09251', name: 'Old name',
                         brand: '3M', list_price: 40.99 }]
    });
    await upload(workbook([
        ['MMM09251', 'New name', null, null, '3M', null, '42.99', null, null, null]
    ]), '?apply=true');

    const changes = fake.db.item_library_changes.filter(c => c.action === 'updated');
    const byField = Object.fromEntries(changes.map(c => [c.field, c]));
    assert.equal(byField.name.old_value, 'Old name');
    assert.equal(byField.name.new_value, 'New name');
    assert.equal(byField.list_price.old_value, '40.99');
    assert.equal(byField.list_price.new_value, '42.99');
    assert.ok(!byField.brand, 'a field that did not change must not be logged as if it had');
});

test('two part numbers that collapse to one key: first wins, second is reported by name', async () => {
    reset();
    const buf = workbook([
        ['J71',  'Shop-Line Coarse Aluminum Ga', null, null, 'PPG', null, '396.70', null, null, null],
        ['J71.', 'Coarse Aluminum QRT.',         null, null, 'PPG', null, '110.04', null, null, null]
    ]);
    const res = await upload(buf, '?apply=true');
    assert.equal(res.body.summary.to_create, 1);
    assert.equal(res.body.summary.skipped, 1);

    const skip = res.body.problems.find(p => p.action === 'skipped');
    assert.match(skip.reason, /J71\./);
    assert.match(skip.reason, /same key/i);
    assert.match(skip.reason, /distinct part numbers/i,
        'the message has to say what to do, not just that something went wrong');
    assert.equal(fake.db.item_library.length, 1);
    assert.equal(fake.db.item_library[0].sku, 'J71');
});

test('a barcode already on another part is refused, not moved', async () => {
    reset({
        item_library: [{ id: 'lib-1', sku: 'MMM06652', sku_key: 'MMM06652',
                         name: '3M Yellow Masking Tape 18mm', barcode: '051131066526' }]
    });
    const buf = workbook([
        ['MMM06652 - ROLL', '18mm Yellow Masking Tape 3/4 Roll', null, null, '3M', null, '9.99', '051131066526', null, null]
    ]);
    const res = await upload(buf, '?apply=true');

    const roll = fake.db.item_library.find(r => r.sku_key === 'MMM06652ROLL');
    assert.ok(roll, 'the part itself is still created');
    assert.equal(roll.barcode, null, 'but without the barcode that belongs to another part');

    const conflict = res.body.problems.find(p => p.action === 'conflict');
    assert.ok(conflict);
    assert.match(conflict.reason, /already on MMM06652/);
    assert.equal(fake.db.item_library.find(r => r.sku_key === 'MMM06652').barcode, '051131066526',
        'the original keeps its code');
});

test('a case barcode is stored as a case barcode', async () => {
    reset();
    await upload(workbook([
        ['J71', 'Shop-Line Coarse Aluminum Ga', null, null, 'PPG', null, '396.70', '10776960887131', null, null],
        ['MMM09251', '3M Disc', null, null, '3M', null, '40.99', '051131020474', null, null]
    ]), '?apply=true');

    assert.equal(fake.db.item_library.find(r => r.sku_key === 'J71').barcode_level, 'case');
    assert.equal(fake.db.item_library.find(r => r.sku_key === 'MMM09251').barcode_level, 'each');
});

test('a row with no name is skipped and says why', async () => {
    reset();
    const res = await upload(workbook([
        ['NOR56064', '', null, null, 'Norton', null, '', '', null, null]
    ]), '?apply=true');
    assert.equal(fake.db.item_library.length, 0);
    const skip = res.body.problems[0];
    assert.match(skip.reason, /no item name/i);
});

test('re-running the same file changes nothing the second time', async () => {
    reset();
    const buf = workbook([
        ['MMM09251', '3M Disc', 'Abrasives', null, '3M', null, '40.99', '051131020474', '1', null],
        ['FUS123EZ', 'Seam Sealer', 'Adhesives', null, 'Norton', null, '143.99', null, null, null]
    ]);
    const first = await upload(buf, '?apply=true');
    assert.equal(first.body.summary.to_create, 2);

    const second = await upload(buf, '?apply=true');
    assert.equal(second.body.summary.to_create, 0);
    assert.equal(second.body.summary.to_update, 0);
    assert.equal(second.body.summary.unchanged, 2, 'an unchanged reload must be a no-op, not a churn of updates');
    assert.equal(fake.db.item_library.length, 2);
});

// ==================================================================
// Access
// ==================================================================

test('a company admin cannot reach the master table at all', async () => {
    reset();
    authAdmin = { id: 'bbbbbbbb-1111-4111-8111-111111111111', role: 'company_admin', company_id: CO_A };
    for (const call of [
        request(app()).get('/master'),
        request(app()).get('/master/stats'),
        request(app()).post('/master/aliases').send({ company_id: CO_A, library_sku: 'X' })
    ]) {
        const res = await call;
        assert.equal(res.status, 403);
    }
});

// ==================================================================
// The crossover table
// ==================================================================

test('a mapping is created unapproved, because CHC guessing is not the customer agreeing', async () => {
    reset({
        item_library: [{ id: 'lib-1', sku: 'MMM06652', sku_key: 'MMM06652', name: '3M Yellow Masking Tape 18mm' }]
    });
    const res = await request(app()).post('/master/aliases')
        .send({ company_id: CO_A, library_sku: 'MMM-06652', product_id: PROD_A });
    assert.equal(res.status, 201);
    assert.equal(res.body.alias.approved, false);
    assert.equal(res.body.alias.library_sku_key, 'MMM06652');
    assert.equal(res.body.alias.alias_sku, 'YELTAPE34', 'the shop\'s own spelling is taken from their product row');
    assert.equal(res.body.alias.alias_name, 'Yellow tape 3/4');
});

test('a mapping cannot point at a part that is not in the master table', async () => {
    reset();
    const res = await request(app()).post('/master/aliases')
        .send({ company_id: CO_A, library_sku: 'GHOST-1', alias_sku: 'X1' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /not in the master table/);
});

test('a mapping cannot be made against another company\'s product', async () => {
    reset({
        item_library: [{ id: 'lib-1', sku: 'MMM06652', sku_key: 'MMM06652', name: 'Tape' }]
    });
    const res = await request(app()).post('/master/aliases')
        .send({ company_id: CO_B, library_sku: 'MMM06652', product_id: PROD_A });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /different company/);
});

test('approving a mapping requires a name, so an approval is evidence of something', async () => {
    reset({
        item_library: [{ id: 'lib-1', sku: 'MMM06652', sku_key: 'MMM06652', name: 'Tape' }]
    });
    const made = await request(app()).post('/master/aliases')
        .send({ company_id: CO_A, library_sku: 'MMM06652', alias_sku: 'YELTAPE34' });
    const id = made.body.alias.id;

    const noName = await request(app()).put(`/master/aliases/${id}`).send({ approved: true });
    assert.equal(noName.status, 400);
    assert.match(noName.body.error, /who at the customer/i);

    const ok = await request(app()).put(`/master/aliases/${id}`)
        .send({ approved: true, approved_by: 'Dave, parts manager' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.alias.approved, true);
    assert.equal(ok.body.alias.approved_by, 'Dave, parts manager');
    assert.ok(ok.body.alias.approved_at);
});

test('the same spelling cannot be mapped to the same part twice', async () => {
    reset({
        item_library: [{ id: 'lib-1', sku: 'MMM06652', sku_key: 'MMM06652', name: 'Tape' }]
    });
    const body = { company_id: CO_A, library_sku: 'MMM06652', alias_sku: 'YELTAPE34' };
    assert.equal((await request(app()).post('/master/aliases').send(body)).status, 201);
    const dup = await request(app()).post('/master/aliases').send(body);
    assert.equal(dup.status, 409);
});
