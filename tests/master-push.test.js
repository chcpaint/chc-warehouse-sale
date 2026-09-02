/**
 * tests/master-push.test.js
 *
 * Pushing master items into customer catalogues, and the commercial rules
 * that stop some of them arriving.
 *
 * The rule that exists today: CHC has no PPG contract covering Assured, so
 * PPG lines must reach every other customer and never that one. Getting this
 * wrong in either direction is a commercial problem, not a bug report — so
 * both directions are tested, not just the block.
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
            if (authAdmin.role !== 'super_admin') return res.status(403).json({ error: 'Super admin access required.' });
            req.admin = authAdmin; next();
        }
    },
    [path.join(ROOT, 'utils/sanitize.js')]: {
        stripHtml: s => String(s === undefined || s === null ? '' : s).replace(/<[^>]*>/g, ''),
        sanitizeObject: o => o,
        isValidUUID: v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '')),
        generateSlug: s => s, validateEmail: () => true
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
const masterTable = require('../routes/master-table');

const ASSURED = '11111111-1111-4111-8111-111111111111';
const BAYVIEW = '22222222-2222-4222-8222-222222222222';
const NORTH   = '33333333-3333-4333-8333-333333333333';

const PPG_1 = 'aaaaaaa1-1111-4111-8111-111111111111';
const PPG_2 = 'aaaaaaa2-2222-4222-8222-222222222222';
const MMM_1 = 'aaaaaaa3-3333-4333-8333-333333333333';
const NOPRICE = 'aaaaaaa4-4444-4444-8444-444444444444';

function reset(extra = {}) {
    fake = createFakeSupabase({
        companies: [
            { id: ASSURED, name: 'Assured Collision', slug: 'assured', is_active: true },
            { id: BAYVIEW, name: 'Bayview Auto Body', slug: 'bayview', is_active: true },
            { id: NORTH,   name: 'Northline Collision', slug: 'northline', is_active: true }
        ],
        item_library: [
            { id: PPG_1, sku: '2PCPSL', sku_key: '2PCPSL', name: 'Two piece Paint Suit Large',
              brand: 'PPG', category: 'Masks/Suits', barcode: '051131020474', list_price: 84.48, case_qty: 20, is_active: true },
            { id: PPG_2, sku: 'J71', sku_key: 'J71', name: 'Shop-Line Coarse Aluminum Ga',
              brand: 'PPG', category: 'Colour', barcode: null, list_price: 396.70, case_qty: 1, is_active: true },
            { id: MMM_1, sku: 'MMM09251', sku_key: 'MMM09251', name: '3M Hookit Gold Disc',
              brand: '3M', category: 'Abrasives', barcode: '051131066526', list_price: 40.99, case_qty: 1, is_active: true },
            { id: NOPRICE, sku: 'INTSS-2', sku_key: 'INTSS2', name: 'Superstand 2',
              brand: 'Innotec', category: 'Equipment', barcode: null, list_price: 0, case_qty: 1, is_active: true }
        ],
        company_catalogue_exclusions: [
            { id: 'ccccccc1-1111-4111-8111-111111111111', company_id: ASSURED, brand: 'PPG', category: null, sku_key: null,
              reason: 'CHC has no PPG contract covering this customer.' }
        ],
        products: [], product_barcodes: [], audit_log: [],
        ...extra
    });
    authAdmin = { id: 'aaaaaaaa-1111-4111-8111-111111111111', role: 'super_admin', company_id: null };
}

function app() {
    const a = express();
    a.use(express.json());
    a.use('/master', masterTable);
    return a;
}

const push = body => request(app()).post('/master/push').send(body);
const skusFor = co => fake.db.products.filter(p => p.company_id === co).map(p => p.sku).sort();

// ==================================================================
// The PPG rule, in both directions
// ==================================================================

test('PPG reaches every customer EXCEPT Assured', async () => {
    reset();
    const res = await push({ all: true, all_companies: true, apply: true });
    assert.equal(res.status, 200);

    assert.deepEqual(skusFor(BAYVIEW), ['2PCPSL', 'INTSS-2', 'J71', 'MMM09251'],
        'every other customer gets the whole master table, PPG included');
    assert.deepEqual(skusFor(NORTH), ['2PCPSL', 'INTSS-2', 'J71', 'MMM09251']);
    assert.deepEqual(skusFor(ASSURED), ['INTSS-2', 'MMM09251'],
        'Assured gets everything except the PPG lines');
});

test('only the PPG lines are withheld — not the rest of the catalogue', async () => {
    reset();
    await push({ all: true, all_companies: true, apply: true });
    const assured = fake.db.products.filter(p => p.company_id === ASSURED);
    assert.ok(assured.some(p => p.brand === '3M'), '3M must still arrive');
    assert.ok(assured.some(p => p.brand === 'Innotec'), 'and every other brand');
    assert.equal(assured.filter(p => p.brand === 'PPG').length, 0);
});

test('the preview says which customer is short, and why, before anything is written', async () => {
    reset();
    const res = await push({ brand: 'PPG', all_companies: true });
    assert.equal(res.body.applied, false);
    assert.equal(fake.db.products.length, 0, 'a preview that writes is not a preview');

    const assured = res.body.by_company.find(c => c.company_id === ASSURED);
    assert.equal(assured.would_add, 0);
    assert.equal(assured.excluded_count, 2);
    assert.match(assured.excluded_reason, /no PPG contract/i,
        'the screen has to show the reason, not just a smaller number');

    const bayview = res.body.by_company.find(c => c.company_id === BAYVIEW);
    assert.equal(bayview.would_add, 2);
    assert.equal(bayview.excluded_count, 0);
});

test('removing the rule lets PPG through', async () => {
    reset();
    const del = await request(app()).delete('/master/exclusions/ccccccc1-1111-4111-8111-111111111111');
    assert.equal(del.status, 200);
    await push({ brand: 'PPG', company_ids: [ASSURED], apply: true });
    assert.deepEqual(skusFor(ASSURED), ['2PCPSL', 'J71']);
});

// ==================================================================
// What a push must not do
// ==================================================================

test('a push never changes a price the customer already has', async () => {
    reset({
        products: [{ id: 'p-1', company_id: BAYVIEW, sku: 'MMM09251', name: 'Their own name',
                     brand: '3M', price: 37.50, is_active: true }]
    });
    await push({ all: true, all_companies: true, apply: true });
    const theirs = fake.db.products.find(p => p.company_id === BAYVIEW && p.sku === 'MMM09251');
    assert.equal(theirs.price, 37.50, 'a button that adds items must not silently reprice the ones already there');
    assert.equal(theirs.name, 'Their own name');
    assert.equal(fake.db.products.filter(p => p.company_id === BAYVIEW && p.sku === 'MMM09251').length, 1,
        'and must not create a duplicate beside it');
});

test('a part with no list price arrives priced on request, never as free', async () => {
    reset();
    await push({ all: true, company_ids: [BAYVIEW], apply: true });
    const stand = fake.db.products.find(p => p.company_id === BAYVIEW && p.sku === 'INTSS-2');
    assert.equal(stand.price_on_request, true);
    const disc = fake.db.products.find(p => p.company_id === BAYVIEW && p.sku === 'MMM09251');
    assert.equal(disc.price_on_request, false);
    assert.equal(disc.price, 40.99);
});

test('the master barcode travels with the item', async () => {
    reset();
    await push({ all: true, company_ids: [BAYVIEW], apply: true });
    const disc = fake.db.products.find(p => p.company_id === BAYVIEW && p.sku === 'MMM09251');
    const code = fake.db.product_barcodes.find(b => b.product_id === disc.id);
    assert.equal(code.barcode, '051131066526', 'the point of master-first is that the barcode comes with it');
    assert.equal(code.is_primary, true);
});

test('pushing the same items twice adds nothing the second time', async () => {
    reset();
    await push({ all: true, all_companies: true, apply: true });
    const before = fake.db.products.length;
    const second = await push({ all: true, all_companies: true, apply: true });
    assert.equal(second.body.summary.to_add, 0);
    assert.equal(fake.db.products.length, before);
});

test('a push has to say what it is pushing and to whom', async () => {
    reset();
    assert.equal((await push({ all_companies: true })).status, 400);
    assert.equal((await push({ all: true })).status, 400);
    assert.match((await push({ all: true })).body.error, /which customers/i);
});

// ==================================================================
// Exclusion rules themselves
// ==================================================================

test('an exclusion must name exactly one thing and say why', async () => {
    reset();
    const noReason = await request(app()).post('/master/exclusions')
        .send({ company_id: BAYVIEW, brand: 'PPG' });
    assert.equal(noReason.status, 400);
    assert.match(noReason.body.error, /why/i);

    const twoThings = await request(app()).post('/master/exclusions')
        .send({ company_id: BAYVIEW, brand: 'PPG', category: 'Colour', reason: 'x' });
    assert.equal(twoThings.status, 400);
    assert.match(twoThings.body.error, /exactly one/i);

    const ok = await request(app()).post('/master/exclusions')
        .send({ company_id: BAYVIEW, brand: 'Norton', reason: 'Contract ends March' });
    assert.equal(ok.status, 201);
});

test('brand matching is not case-sensitive, because spreadsheets are not', async () => {
    reset({
        company_catalogue_exclusions: [
            { id: 'ccccccc2-2222-4222-8222-222222222222', company_id: ASSURED, brand: 'ppg', category: null, sku_key: null, reason: 'no contract' }
        ]
    });
    await push({ all: true, company_ids: [ASSURED], apply: true });
    assert.equal(fake.db.products.filter(p => p.company_id === ASSURED && p.brand === 'PPG').length, 0);
});

// ==================================================================
// Master-first editing
// ==================================================================

test('an item is added to the master, not to a company', async () => {
    reset();
    const res = await request(app()).post('/master/items')
        .send({ sku: 'NEW-1', name: 'A new part', brand: '3M', list_price: 10, barcode: '012345678905' });
    assert.equal(res.status, 201);
    assert.equal(fake.db.item_library.length, 5);
    assert.equal(fake.db.products.length, 0, 'adding to the master must not touch any catalogue on its own');
    assert.equal(res.body.item.barcode_level, 'each');
});

test('the master refuses a part that is already there under another spelling', async () => {
    reset();
    const res = await request(app()).post('/master/items').send({ sku: 'MMM-09251', name: 'Duplicate' });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /already the same part as MMM09251/);
});

test('the master refuses a barcode that is already on another part', async () => {
    reset();
    const res = await request(app()).post('/master/items')
        .send({ sku: 'NEW-2', name: 'Another part', barcode: '051131066526' });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /already on MMM09251/);
});

test('a master item can be corrected once, and every customer gets it next push', async () => {
    reset();
    const res = await request(app()).put(`/master/items/${MMM_1}`)
        .send({ name: '3M Hookit Gold Abrasive Disc 80D 6in', list_price: 42.99 });
    assert.equal(res.status, 200);
    assert.equal(fake.db.item_library.find(i => i.id === MMM_1).name, '3M Hookit Gold Abrasive Disc 80D 6in');
});
