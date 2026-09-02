/**
 * tests/catalogue-sync.test.js
 *
 * Bringing every customer's catalogue into line with the master.
 *
 * A mass rename across every customer is the kind of operation that is either
 * exactly right or quietly ruinous, so these tests are almost all about what
 * it must REFUSE to do:
 *
 *   - never write to a frozen customer
 *   - never move a price
 *   - never add or remove a row
 *   - never give two rows in one catalogue the same part number
 *   - never put one barcode on two products in one catalogue
 *   - never touch a product that does not already resolve to a master item
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
    get: (_t, prop) => { const v = fake[prop]; return typeof v === 'function' ? v.bind(fake) : v; }
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
        stripHtml: s => String(s ?? ''), sanitizeObject: o => o,
        isValidUUID: v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '')),
        generateSlug: s => s, validateEmail: () => true
    },
    [path.join(ROOT, 'middleware/upload.js')]: {
        catalogUpload: { single: () => (q, r, n) => n() },
        logoUpload: { single: () => (q, r, n) => n() },
        invoiceUpload: { single: () => (q, r, n) => n() }
    }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (parent && request.startsWith('.')) {
        const resolved = path.resolve(path.dirname(parent.filename), request);
        for (const key of Object.keys(stubs)) if (key === resolved || key === resolved + '.js') return stubs[key];
    }
    return originalLoad.call(this, request, parent, isMain);
};

const express = require('express');
const request = require('supertest');
const masterTable = require('../routes/master-table');

const ASSURED = '11111111-1111-4111-8111-111111111111';
const BAYVIEW = '22222222-2222-4222-8222-222222222222';
const P_ASSURED = 'aaaaaaa1-1111-4111-8111-111111111111';
const P_BAY     = 'aaaaaaa2-2222-4222-8222-222222222222';
const P_UNKNOWN = 'aaaaaaa3-3333-4333-8333-333333333333';

function reset(extra = {}) {
    fake = createFakeSupabase({
        companies: [
            { id: ASSURED, name: 'Assured Collision', slug: 'assured', is_active: true },
            { id: BAYVIEW, name: 'Bayview Auto Body', slug: 'bayview', is_active: true }
        ],
        company_catalogue_policy: [
            { company_id: ASSURED, push_mode: 'frozen', reason: 'Their list is an agreed set. Nothing automated touches it.' }
        ],
        item_library: [
            { id: 'lib-1', sku: 'MMM09251', sku_key: 'MMM09251',
              name: '3M Hookit Gold Disc 80D 6in', barcode: '051131020474', is_active: true }
        ],
        products: [
            // Both shops hold the same part, spelled and named their own way.
            { id: P_ASSURED, company_id: ASSURED, sku: 'MMM-09251', name: 'gold disc 6in',
              brand: '3M', price: 38.00, is_active: true },
            { id: P_BAY, company_id: BAYVIEW, sku: 'mmm 09251', name: 'Hookit disc',
              brand: '3M', price: 41.50, is_active: true },
            // Not in the master at all.
            { id: P_UNKNOWN, company_id: BAYVIEW, sku: 'HOUSE-BLEND-1', name: 'Their own thing',
              brand: 'CHC', price: 9.99, is_active: true }
        ],
        product_barcodes: [], catalogue_sync_runs: [], catalogue_sync_changes: [], audit_log: [],
        ...extra
    });
    authAdmin = { id: 'aaaaaaaa-1111-4111-8111-111111111111', role: 'super_admin', company_id: null };
}

function app() { const a = express(); a.use(express.json()); a.use('/master', masterTable); return a; }
const sync = body => request(app()).post('/master/sync').send(body);
const prod = id => fake.db.products.find(p => p.id === id);

// ==================================================================
// Assured is never touched
// ==================================================================

test('a frozen customer is not written to, at all', async () => {
    reset();
    const before = JSON.stringify(prod(P_ASSURED));
    await sync({ all_companies: true, apply: true });
    assert.equal(JSON.stringify(prod(P_ASSURED)), before,
        'not the name, not the part number, not one character');
    assert.equal(fake.db.product_barcodes.filter(b => b.product_id === P_ASSURED).length, 0);
});

test('a frozen customer is reported as left alone, with the reason', async () => {
    reset();
    const res = await sync({ all_companies: true });
    assert.equal(res.body.summary.customers_left_alone, 1);
    assert.equal(res.body.summary.customers_synced, 1);
    const left = res.body.left_alone[0];
    assert.equal(left.company_name, 'Assured Collision');
    assert.match(left.reason, /agreed set/);
    assert.ok(!res.body.by_company.some(c => c.company_id === ASSURED),
        'a frozen customer must not even appear as a candidate');
});

test('naming a frozen customer explicitly still does not touch them', async () => {
    reset();
    const before = JSON.stringify(prod(P_ASSURED));
    const res = await sync({ company_ids: [ASSURED], apply: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.summary.products_changing, 0);
    assert.equal(JSON.stringify(prod(P_ASSURED)), before,
        'asking for them by name is not a way around it');
});

// ==================================================================
// What it does for everyone else
// ==================================================================

test('name, part number and barcode all come into line', async () => {
    reset();
    await sync({ all_companies: true, apply: true });
    const p = prod(P_BAY);
    assert.equal(p.name, '3M Hookit Gold Disc 80D 6in');
    assert.equal(p.sku, 'MMM09251');
    const code = fake.db.product_barcodes.find(b => b.product_id === P_BAY);
    assert.equal(code.barcode, '051131020474');
    assert.equal(code.is_primary, true);
});

test('the price is never touched', async () => {
    reset();
    await sync({ all_companies: true, apply: true });
    assert.equal(prod(P_BAY).price, 41.50, 'a sync that moves prices is not a sync');
});

test('nothing is added and nothing is removed', async () => {
    reset();
    const before = fake.db.products.length;
    await sync({ all_companies: true, apply: true });
    assert.equal(fake.db.products.length, before);
});

test('a product that is not in the master is left exactly as it is', async () => {
    reset();
    const before = JSON.stringify(prod(P_UNKNOWN));
    await sync({ all_companies: true, apply: true });
    assert.equal(JSON.stringify(prod(P_UNKNOWN)), before,
        'guessing at an unmatched part could merge two different items');
});

test('only the fields asked for are changed', async () => {
    reset();
    await sync({ all_companies: true, fields: ['name'], apply: true });
    assert.equal(prod(P_BAY).name, '3M Hookit Gold Disc 80D 6in');
    assert.equal(prod(P_BAY).sku, 'mmm 09251', 'the part number was not in scope');
    assert.equal(fake.db.product_barcodes.length, 0);
});

test('every rewritten value is recorded with what it was before', async () => {
    reset();
    await sync({ all_companies: true, apply: true });
    const byField = Object.fromEntries(fake.db.catalogue_sync_changes.map(c => [c.field, c]));
    assert.equal(byField.name.old_value, 'Hookit disc');
    assert.equal(byField.name.new_value, '3M Hookit Gold Disc 80D 6in');
    assert.equal(byField.sku.old_value, 'mmm 09251');
    assert.equal(byField.barcode.old_value, null);
    assert.equal(byField.barcode.new_value, '051131020474');
});

test('a preview writes nothing', async () => {
    reset();
    const res = await sync({ all_companies: true });
    assert.equal(res.body.applied, false);
    assert.equal(prod(P_BAY).name, 'Hookit disc');
    assert.equal(res.body.summary.products_changing, 1);
    assert.equal(res.body.summary.names, 1);
    assert.equal(res.body.summary.part_numbers, 1);
    assert.equal(res.body.summary.barcodes, 1);
});

test('running it twice changes nothing the second time', async () => {
    reset();
    await sync({ all_companies: true, apply: true });
    const res = await sync({ all_companies: true });
    assert.equal(res.body.summary.products_changing, 0);
});

// ==================================================================
// The collisions it must refuse
// ==================================================================

test('two rows for one part are refused rather than given the same part number', async () => {
    reset({
        products: [
            { id: P_BAY, company_id: BAYVIEW, sku: 'mmm 09251', name: 'Hookit disc', price: 41.50, is_active: true },
            { id: 'aaaaaaa9-9999-4999-8999-999999999999', company_id: BAYVIEW,
              sku: 'MMM-09251', name: 'Hookit disc (duplicate row)', price: 40.00, is_active: true }
        ]
    });
    const res = await sync({ all_companies: true, apply: true });
    const blocked = res.body.needs_a_decision.filter(c => c.field === 'sku');
    assert.equal(blocked.length, 2, 'both rows are reported, not silently renamed');
    assert.match(blocked[0].reason, /more than one product/);
    assert.match(blocked[0].reason, /merge them first/);
    const skus = fake.db.products.filter(p => p.company_id === BAYVIEW).map(p => p.sku).sort();
    assert.deepEqual(skus, ['MMM-09251', 'mmm 09251'], 'neither part number was changed');
    // The names still come into line — only the part number is the problem.
    assert.ok(fake.db.products.every(p => p.name === '3M Hookit Gold Disc 80D 6in'));
});

test('a barcode already on another product in the same shop is refused', async () => {
    reset({
        products: [
            { id: P_BAY, company_id: BAYVIEW, sku: 'mmm 09251', name: 'Hookit disc', price: 41.50, is_active: true },
            { id: 'aaaaaaa8-8888-4888-8888-888888888888', company_id: BAYVIEW,
              sku: 'OTHER-1', name: 'Something else', price: 5, is_active: true }
        ],
        product_barcodes: [
            { id: 'bc-x', product_id: 'aaaaaaa8-8888-4888-8888-888888888888',
              barcode: '051131020474', is_primary: true }
        ]
    });
    const res = await sync({ all_companies: true, apply: true });
    const blocked = res.body.needs_a_decision.find(c => c.field === 'barcode');
    assert.ok(blocked, 'it has to be reported');
    assert.match(blocked.reason, /already on another product/);
    assert.equal(fake.db.product_barcodes.filter(b => b.barcode === '051131020474').length, 1,
        'one code, one product');
});

test('a company admin cannot run a sync', async () => {
    reset();
    authAdmin = { id: 'bbbbbbbb-1111-4111-8111-111111111111', role: 'company_admin', company_id: BAYVIEW };
    assert.equal((await sync({ all_companies: true, apply: true })).status, 403);
});

test('a sync has to say who it is for', async () => {
    reset();
    const res = await sync({ apply: true });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /which customers/i);
});

// ==================================================================
// Brand
//
// A wrong brand is not cosmetic. The catalogue's brand filter is how anyone
// finds a product line, so a PPG part filed as "Uncategorized" is invisible
// to the person looking for it — which is exactly how a shop concludes it
// does not stock a line it does stock.
// ==================================================================

test('a wrong brand is corrected to the master', async () => {
    reset({
        item_library: [{ id: 'lib-1', sku: 'J71', sku_key: 'J71',
                         name: 'Shop-Line Coarse Aluminum Ga', brand: 'PPG', barcode: null, is_active: true }],
        products: [{ id: P_BAY, company_id: BAYVIEW, sku: 'J71', name: 'Shop-Line Coarse Aluminum Ga',
                     brand: 'Uncategorized', price: 396.70, is_active: true }]
    });
    const res = await sync({ all_companies: true, apply: true });
    assert.equal(prod(P_BAY).brand, 'PPG');
    assert.equal(res.body.summary.brands, 1);
    const logged = fake.db.catalogue_sync_changes.find(c => c.field === 'brand');
    assert.equal(logged.old_value, 'Uncategorized');
    assert.equal(logged.new_value, 'PPG');
});

test('brand can be left out of a sync like any other field', async () => {
    reset({
        item_library: [{ id: 'lib-1', sku: 'J71', sku_key: 'J71', name: 'Shop-Line Coarse Aluminum Ga',
                         brand: 'PPG', barcode: null, is_active: true }],
        products: [{ id: P_BAY, company_id: BAYVIEW, sku: 'J71', name: 'Wrong name',
                     brand: 'Uncategorized', price: 396.70, is_active: true }]
    });
    await sync({ all_companies: true, fields: ['name'], apply: true });
    assert.equal(prod(P_BAY).name, 'Shop-Line Coarse Aluminum Ga');
    assert.equal(prod(P_BAY).brand, 'Uncategorized', 'brand was not in scope');
});

test('a blank brand in the master never wipes the one a shop has', async () => {
    reset({
        item_library: [{ id: 'lib-1', sku: 'J71', sku_key: 'J71', name: 'Coarse Aluminum',
                         brand: null, barcode: null, is_active: true }],
        products: [{ id: P_BAY, company_id: BAYVIEW, sku: 'J71', name: 'Coarse Aluminum',
                     brand: 'PPG', price: 396.70, is_active: true }]
    });
    await sync({ all_companies: true, apply: true });
    assert.equal(prod(P_BAY).brand, 'PPG', 'the master not knowing is not the same as the master saying "none"');
});

// ==================================================================
// Master prices
//
// Most pricing is per customer and nothing automated moves it. PPG is the
// exception: one list price everywhere. That used to happen as a side effect
// of one customer's file upload, with no preview and no record of who caused
// it. As a deliberate action it needs to be previewable, scoped, and logged.
// ==================================================================

const priceRun = body => request(app()).post('/master/prices').send(body);

function resetPrices(extra = {}) {
    reset({
        item_library: [
            { id: 'lib-1', sku: 'J71', sku_key: 'J71', name: 'Shop-Line Coarse Aluminum Ga',
              brand: 'PPG', barcode: null, list_price: 396.70, is_active: true },
            { id: 'lib-2', sku: 'MMM09251', sku_key: 'MMM09251', name: '3M Hookit Gold Disc',
              brand: '3M', barcode: null, list_price: 40.99, is_active: true }
        ],
        products: [
            { id: P_BAY, company_id: BAYVIEW, sku: 'J71', name: 'Shop-Line Coarse Aluminum Ga',
              brand: 'PPG', price: 380.00, is_active: true },
            { id: P_UNKNOWN, company_id: BAYVIEW, sku: 'MMM09251', name: '3M Hookit Gold Disc',
              brand: '3M', price: 37.50, is_active: true },
            { id: P_ASSURED, company_id: ASSURED, sku: 'J71', name: 'Shop-Line Coarse Aluminum Ga',
              brand: 'PPG', price: 396.70, is_active: true }
        ],
        ...extra
    });
}

test('applying master prices moves only the named brand', async () => {
    resetPrices();
    await priceRun({ brand: 'PPG', all_companies: true, apply: true });
    assert.equal(prod(P_BAY).price, 396.70, 'the PPG item comes to the master price');
    assert.equal(prod(P_UNKNOWN).price, 37.50, 'the 3M item is left alone — its price is theirs');
});

test('it says which way each price is moving before it moves', async () => {
    resetPrices();
    const res = await priceRun({ brand: 'PPG', all_companies: true });
    assert.equal(res.body.applied, false);
    assert.equal(res.body.summary.prices_changing, 1);
    assert.equal(res.body.summary.going_up, 1);
    assert.equal(res.body.summary.going_down, 0);
    assert.equal(prod(P_BAY).price, 380.00, 'a preview that repriced would not be a preview');
});

test('a price already correct is not rewritten', async () => {
    // Assured is CLOSED here, not frozen — which is how production has it.
    // Closed means "no new items", not "wrong prices forever", so they are a
    // candidate for repricing and their already-correct price must simply be
    // left alone rather than counted as a change.
    resetPrices({
        company_catalogue_policy: [
            { company_id: ASSURED, push_mode: 'closed', reason: 'Agreed list; nothing new added.' }
        ]
    });
    const res = await priceRun({ brand: 'PPG', all_companies: true });
    const assured = res.body.by_company.find(c => c.company_id === ASSURED);
    assert.ok(assured, 'a closed catalogue is still repriced');
    assert.equal(assured.matched, 1);
    assert.equal(assured.changing, 0, 'already at the master price');
    assert.equal(res.body.summary.prices_changing, 1, 'only Bayview moves');
});

test('every price change is logged with what it was', async () => {
    resetPrices();
    await priceRun({ brand: 'PPG', all_companies: true, apply: true });
    const logged = fake.db.catalogue_sync_changes.find(c => c.field === 'price');
    assert.equal(logged.old_value, '380');
    assert.equal(logged.new_value, '396.7');
});

test('there is no "reprice everything" — a brand has to be named', async () => {
    resetPrices();
    const res = await priceRun({ all_companies: true, apply: true });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /most pricing is per customer/i);
});

test('a frozen customer is not repriced', async () => {
    resetPrices({
        company_catalogue_policy: [
            { company_id: BAYVIEW, push_mode: 'frozen', reason: 'Leave them alone.' }
        ]
    });
    await priceRun({ brand: 'PPG', all_companies: true, apply: true });
    assert.equal(prod(P_BAY).price, 380.00);
});

// ==================================================================
// What the master is missing
// ==================================================================

test('the gaps report finds what customers know and the master does not', async () => {
    reset({
        item_library: [
            { id: 'lib-1', sku: 'T4000', sku_key: 'T4000', name: 'EHP Crystal Silver hL',
              brand: 'PPG', category: null, barcode: null, list_price: null, is_active: true }
        ],
        products: [
            { id: P_BAY, company_id: BAYVIEW, sku: 'T4000', name: 'EHP Crystal Silver hL',
              brand: 'PPG', category: 'Colour', price: 1056.14, is_active: true },
            { id: P_ASSURED, company_id: ASSURED, sku: 'T4000', name: 'EHP Crystal Silver hL',
              brand: 'PPG', category: 'Colour', price: 1056.14, is_active: true }
        ],
        product_barcodes: [
            { id: 'bc-1', product_id: P_BAY, barcode: '5025427724525', is_primary: true }
        ]
    });
    const res = await request(app()).get('/master/gaps');
    assert.equal(res.status, 200);

    const cat = res.body.category[0];
    assert.equal(cat.sku, 'T4000');
    assert.equal(cat.suggestions[0].value, 'Colour');
    assert.equal(cat.suggestions[0].agreement, 2, 'both customers say the same thing');
    assert.deepEqual(cat.suggestions[0].customers.sort(), ['Assured Collision', 'Bayview Auto Body']);

    assert.equal(res.body.barcode[0].suggestions[0].value, '5025427724525');
    assert.equal(res.body.list_price[0].suggestions[0].value, '1056.14');
    assert.equal(res.body.summary.missing_a_barcode, 1);
    assert.equal(res.body.summary.barcode_fillable_from_a_customer, 1);
});

test('where customers disagree, every answer is shown rather than one being picked', async () => {
    reset({
        item_library: [
            { id: 'lib-1', sku: 'J71', sku_key: 'J71', name: 'Coarse Aluminum',
              brand: null, category: null, barcode: null, list_price: 1, is_active: true }
        ],
        products: [
            { id: P_BAY, company_id: BAYVIEW, sku: 'J71', name: 'x', brand: 'PPG', price: 1, is_active: true },
            { id: P_ASSURED, company_id: ASSURED, sku: 'J71', name: 'x', brand: 'Shop-Line', price: 1, is_active: true }
        ]
    });
    const res = await request(app()).get('/master/gaps');
    const brand = res.body.brand[0];
    assert.equal(brand.suggestions.length, 2, 'a disagreement is a decision for a person, not something to average');
    assert.ok(brand.suggestions.every(s => s.agreement === 1));
});

test('a field the master already has is not reported as a gap', async () => {
    reset({
        item_library: [
            { id: 'lib-1', sku: 'J71', sku_key: 'J71', name: 'Coarse Aluminum',
              brand: 'PPG', category: 'Colour', barcode: '123', list_price: 5, is_active: true }
        ],
        products: [
            { id: P_BAY, company_id: BAYVIEW, sku: 'J71', name: 'x', brand: 'Other',
              category: 'Something else', price: 9, is_active: true }
        ]
    });
    const res = await request(app()).get('/master/gaps');
    assert.deepEqual(res.body.brand, []);
    assert.deepEqual(res.body.category, []);
    assert.deepEqual(res.body.list_price, []);
});
