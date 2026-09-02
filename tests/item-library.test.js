/**
 * tests/item-library.test.js
 *
 * The Item Library, exercised through HTTP.
 *
 * The rules worth defending here are the ones whose failure is invisible until
 * it is expensive:
 *
 *   * adding an item the shop already sells would create a duplicate SKU in a
 *     live store, and nobody notices until two lines appear on one order
 *   * a $0 price on a real product is an order CHC cannot invoice
 *   * a barcode that already points at a different product makes every scan of
 *     it a coin toss, which corrupts stock counts silently
 *
 * Each of those is a test below, and each is written so that a regression fails
 * loudly rather than producing plausible-looking data.
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

const supabaseProxy = new Proxy({}, {
    get: (_t, prop) => {
        const v = fake[prop];
        return typeof v === 'function' ? v.bind(fake) : v;
    }
});

const ADMIN = { id: '99999999-9999-4999-8999-999999999999', role: 'super_admin' };

const stubs = {
    [path.join(ROOT, 'utils/supabase.js')]: { supabaseAdmin: supabaseProxy },
    [path.join(ROOT, 'middleware/auth.js')]: {
        requireCompanyAuth: (req, res, next) => next(),
        requireAdminAuth: (req, res, next) => { req.admin = ADMIN; next(); },
        requireSuperAdmin: (req, res, next) => next(),
        requireCompanyAccess: (req, res, next) => { req.admin = ADMIN; next(); }
    },
    [path.join(ROOT, 'utils/sanitize.js')]: {
        stripHtml: (s) => String(s === undefined || s === null ? '' : s).replace(/<[^>]*>/g, ''),
        sanitizeObject: (o) => o,
        isValidUUID: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '')),
        generateSlug: (s) => s,
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
const libraryRoutes = require('../routes/item-library');

const CO    = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const L_NEW    = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const L_HAVE   = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const L_NOBC   = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const L_DUPBC  = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4';

const P_HAVE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';

function reset() {
    fake = createFakeSupabase({
        companies: [{ id: CO, name: 'Test Shop', slug: 'test', is_active: true }],
        products: [{
            id: P_HAVE, company_id: CO, sku: 'MMM-06652', name: 'Yellow tape (their name)',
            brand: '3M', price: 44.00, is_active: true, price_on_request: false
        }],
        product_barcodes: [{
            id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
            product_id: P_HAVE, barcode: '051131066526', is_primary: true, source: 'shop'
        }],
        item_library: [
            { id: L_NEW, sku: 'MMM31371', sku_key: 'MMM31371',
              name: '3M Cubitron II Hookit Abrasive Disc P80 6in', brand: '3M',
              vendor_code: 'MMM', barcode: '051131313712', unit: 'EACH', case_qty: 1, list_price: 93.99 },
            // Same item the shop already sells, under the canonical SKU spelling.
            { id: L_HAVE, sku: 'MMM06652', sku_key: 'MMM06652',
              name: '3M Yellow Masking Tape 18mm', brand: '3M',
              vendor_code: 'MMM', barcode: '051131066526', unit: 'EACH', case_qty: 1, list_price: 187.49 },
            { id: L_NOBC, sku: 'NOR12345', sku_key: 'NOR12345',
              name: 'Norton Speed Grip Disc P150', brand: 'Norton',
              vendor_code: 'NOR', barcode: null, unit: 'EACH', case_qty: 1, list_price: null },
            // Carries a barcode the shop has already attached to another product.
            { id: L_DUPBC, sku: 'MMM06652ROLL', sku_key: 'MMM06652ROLL',
              name: '3M Yellow Masking Tape 18mm — single roll', brand: '3M',
              vendor_code: 'MMM', barcode: '051131066526', unit: 'EACH', case_qty: 1, list_price: 6.66 }
        ],
        item_library_conflicts: []
    });
}

function app() {
    const a = express();
    a.use(express.json());
    a.use('/api/admin/companies/:companyId/library', libraryRoutes);
    return a;
}

const url = (p = '') => `/api/admin/companies/${CO}/library${p}`;

// ==================================================================
// The route runs at all
// ==================================================================

test('the library route runs — no missing imports', async () => {
    reset();
    const res = await request(app()).get(url('?q=MMM31371'));
    assert.notEqual(res.status, 500, `library route threw: ${JSON.stringify(res.body)}`);
    assert.equal(res.status, 200);
});

// ==================================================================
// Searching
// ==================================================================

test('an exact SKU finds the item', async () => {
    reset();
    const res = await request(app()).get(url('?q=MMM31371'));
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].sku, 'MMM31371');
});

test('punctuation in the typed SKU does not matter', async () => {
    reset();
    const res = await request(app()).get(url('?q=mmm-313-71'));
    assert.equal(res.body.items[0]?.sku, 'MMM31371',
        'a person typing dashes must land on the same part');
});

test('a barcode scan finds the item', async () => {
    reset();
    const res = await request(app()).get(url('?q=051131313712'));
    assert.equal(res.body.items[0]?.sku, 'MMM31371');
});

test('every typed word has to match, so multi-word searches work', async () => {
    reset();
    const res = await request(app()).get(url('?q=cubitron%20hookit%20disc'));
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].sku, 'MMM31371');
});

test('the search says which items the shop already sells', async () => {
    reset();
    const res = await request(app()).get(url('?q=MMM06652'));
    const hit = res.body.items.find(i => i.sku === 'MMM06652');
    assert.equal(hit.already_in_catalogue, true,
        'without this the console would offer to add a SKU the shop already has');
    assert.equal(hit.existing_product_id, P_HAVE);
});

test('"already in catalogue" is per company, not global', async () => {
    reset();
    const res = await request(app())
        .get(`/api/admin/companies/${OTHER}/library?q=MMM06652`);
    const hit = res.body.items.find(i => i.sku === 'MMM06652');
    assert.equal(hit.already_in_catalogue, false,
        'one shop stocking an item must never mark it as stocked for another');
});

test('only_new hides what the shop already has', async () => {
    reset();
    const res = await request(app()).get(url('?q=MMM&only_new=1'));
    assert.ok(res.body.items.every(i => !i.already_in_catalogue));
    assert.ok(!res.body.items.some(i => i.sku === 'MMM06652'));
});

test('the vendor filter is applied', async () => {
    reset();
    const res = await request(app()).get(url('?q=&vendors=NOR'));
    assert.ok(res.body.items.length > 0);
    assert.ok(res.body.items.every(i => i.vendor_code === 'NOR'));
});

test('the library price is labelled a suggestion, never a price', async () => {
    reset();
    const res = await request(app()).get(url('?q=MMM31371'));
    const item = res.body.items[0];
    assert.equal(item.suggested_price, 93.99);
    assert.equal(item.price, undefined,
        'calling it "price" invites the console to apply a supplier list price as a shop price');
});

// ==================================================================
// Adding
// ==================================================================

test('an item is added to this company at the price given', async () => {
    reset();
    const res = await request(app()).post(url('/add'))
        .send({ items: [{ library_id: L_NEW, price: 79.5 }] });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.summary.added, 1);

    const created = fake.db.products.find(p => p.sku === 'MMM31371');
    assert.ok(created);
    assert.equal(created.company_id, CO);
    assert.equal(Number(created.price), 79.5);
    assert.equal(created.price_on_request, false);
});

test('the barcode comes across with the item', async () => {
    reset();
    await request(app()).post(url('/add'))
        .send({ items: [{ library_id: L_NEW, price: 79.5 }] });

    const created = fake.db.products.find(p => p.sku === 'MMM31371');
    const bc = fake.db.product_barcodes.find(b => b.product_id === created.id);
    assert.equal(bc?.barcode, '051131313712');
});

test('an item the shop already sells is skipped, not duplicated', async () => {
    reset();
    const before = fake.db.products.length;
    const res = await request(app()).post(url('/add'))
        .send({ items: [{ library_id: L_HAVE, price: 200 }] });

    assert.equal(res.body.summary.added, 0);
    assert.equal(res.body.summary.skipped, 1);
    assert.equal(res.body.skipped[0].reason, 'already_in_catalogue');
    assert.equal(fake.db.products.length, before,
        'a duplicate SKU in a live store is the failure this rule exists to prevent');
});

test('the shop\'s own name and price survive a skip', async () => {
    reset();
    await request(app()).post(url('/add')).send({ items: [{ library_id: L_HAVE, price: 200 }] });
    const theirs = fake.db.products.find(p => p.id === P_HAVE);
    assert.equal(theirs.name, 'Yellow tape (their name)');
    assert.equal(Number(theirs.price), 44.00);
});

test('an item with no price is refused rather than added at zero', async () => {
    reset();
    const res = await request(app()).post(url('/add'))
        .send({ items: [{ library_id: L_NOBC }] });

    assert.equal(res.body.summary.added, 0);
    assert.equal(res.body.failed[0].reason, 'price_required');
    assert.equal(fake.db.products.find(p => p.sku === 'NOR12345'), undefined,
        'a $0 line in a live store is an order CHC cannot invoice');
});

test('"contact for current pricing" is an explicit choice, and it works', async () => {
    reset();
    const res = await request(app()).post(url('/add'))
        .send({ items: [{ library_id: L_NOBC, price_on_request: true }] });

    assert.equal(res.body.summary.added, 1);
    const created = fake.db.products.find(p => p.sku === 'NOR12345');
    assert.equal(created.price_on_request, true);
    assert.equal(Number(created.price), 0);
});

test('a negative price is refused', async () => {
    reset();
    const res = await request(app()).post(url('/add'))
        .send({ items: [{ library_id: L_NEW, price: -5 }] });
    assert.equal(res.body.summary.added, 0);
    assert.equal(res.body.failed[0].reason, 'price_required');
});

test('a barcode already used by another product is not attached', async () => {
    reset();
    const res = await request(app()).post(url('/add'))
        .send({ items: [{ library_id: L_DUPBC, price: 6.66 }] });

    assert.equal(res.body.summary.added, 1, 'the item itself is fine — only the barcode is ambiguous');
    assert.equal(res.body.added[0].barcode_applied, false);
    assert.equal(res.body.added[0].barcode_skipped_as_duplicate, true);

    const created = fake.db.products.find(p => p.sku === 'MMM06652ROLL');
    const bcs = fake.db.product_barcodes.filter(b => b.product_id === created.id);
    assert.equal(bcs.length, 0,
        'two products sharing one barcode makes every scan of it a coin toss');
});

test('a mixed batch reports added, skipped and failed separately', async () => {
    reset();
    const res = await request(app()).post(url('/add')).send({
        items: [
            { library_id: L_NEW,  price: 79.5 },   // added
            { library_id: L_HAVE, price: 200 },    // skipped
            { library_id: L_NOBC }                 // failed — no price
        ]
    });
    assert.deepEqual(res.body.summary, { added: 1, skipped: 1, failed: 1 });
});

test('an unknown library id fails rather than inventing a product', async () => {
    reset();
    const res = await request(app()).post(url('/add'))
        .send({ items: [{ library_id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd9', price: 10 }] });
    assert.equal(res.body.failed[0].reason, 'not_in_library');
    assert.equal(res.body.summary.added, 0);
});

test('an empty batch is a bad request, not a silent success', async () => {
    reset();
    const res = await request(app()).post(url('/add')).send({ items: [] });
    assert.equal(res.status, 400);
});

test('an oversized batch is refused', async () => {
    reset();
    const items = Array.from({ length: 201 }, () => ({ library_id: L_NEW, price: 1 }));
    const res = await request(app()).post(url('/add')).send({ items });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /at most/i);
});

test('adding is written to the audit log', async () => {
    reset();
    await request(app()).post(url('/add')).send({ items: [{ library_id: L_NEW, price: 79.5 }] });
    const entry = (fake.db.audit_log || []).find(a => a.action === 'products_added_from_library');
    assert.ok(entry, 'inventory is open to all staff, so who added what has to be recorded');
    assert.equal(entry.admin_id, ADMIN.id);
});

// ==================================================================
// Conflicts
// ==================================================================

test('open barcode conflicts are listed for this company only', async () => {
    reset();
    fake.db.item_library_conflicts.push(
        { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1', company_id: CO, product_id: P_HAVE,
          sku: 'MMM-06652', barcode: '051131066526', reason: 'shared_by_two_skus', resolved_at: null },
        { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2', company_id: OTHER, product_id: P_HAVE,
          sku: 'OTHER-1', barcode: '999', reason: 'shared_by_two_skus', resolved_at: null }
    );
    const res = await request(app()).get(url('/conflicts'));
    assert.equal(res.body.conflicts.length, 1);
    assert.equal(res.body.conflicts[0].company_id ?? CO, CO);
    assert.equal(res.body.conflicts[0].sku, 'MMM-06652');
});

test('resolved conflicts drop off the list', async () => {
    reset();
    fake.db.item_library_conflicts.push({
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3', company_id: CO, product_id: P_HAVE,
        sku: 'MMM-06652', barcode: '051131066526', reason: 'shared_by_two_skus',
        resolved_at: '2026-08-26T00:00:00Z'
    });
    const res = await request(app()).get(url('/conflicts'));
    assert.equal(res.body.conflicts.length, 0);
});

// ==================================================================
// The asterisk
// ==================================================================

test('the supplier\'s leading asterisk is not shown to a counter person', async () => {
    reset();
    fake.db.item_library.push({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5', sku: 'NOR99999', sku_key: 'NOR99999',
        name: '* Norton Widget', brand: 'Norton', vendor_code: 'NOR',
        barcode: null, unit: 'EACH', case_qty: 1, list_price: 5
    });
    const res = await request(app()).get(url('?q=NOR99999'));
    assert.equal(res.body.items[0].name, 'Norton Widget');
});

test('the asterisk is stripped from the name the product is created with', async () => {
    reset();
    fake.db.item_library.push({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6', sku: 'NOR88888', sku_key: 'NOR88888',
        name: '* Norton Gadget', brand: 'Norton', vendor_code: 'NOR',
        barcode: null, unit: 'EACH', case_qty: 1, list_price: 5
    });
    await request(app()).post(url('/add'))
        .send({ items: [{ library_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6', price: 5 }] });
    assert.equal(fake.db.products.find(p => p.sku === 'NOR88888').name, 'Norton Gadget');
});

test('the stored library row keeps the asterisk, in case it means something', async () => {
    reset();
    fake.db.item_library.push({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7', sku: 'NOR77777', sku_key: 'NOR77777',
        name: '* Norton Thing', brand: 'Norton', vendor_code: 'NOR',
        barcode: null, unit: 'EACH', case_qty: 1, list_price: 5
    });
    await request(app()).get(url('?q=NOR77777'));
    const row = fake.db.item_library.find(l => l.sku === 'NOR77777');
    assert.equal(row.name, '* Norton Thing',
        'stripping it in the database would throw away a signal nobody has decoded yet');
});

test('the library refuses to bulk-add into a closed catalogue', async () => {
    // The other half of the guard. Blocking the master push alone would leave
    // the Item Library screen as an open door into the same catalogue.
    reset();
    fake.db.company_catalogue_policy = [
        { company_id: CO, push_mode: 'closed',
          reason: 'Their list is a specific agreed set of items.' }
    ];
    const res = await request(app()).post(url('/add'))
        .send({ items: [{ library_id: L_NEW }] });
    assert.equal(res.status, 409);
    assert.equal(res.body.catalogue_closed, true);
    assert.match(res.body.error, /closed to bulk additions/);
    assert.match(res.body.error, /Products screen/,
        'the refusal has to say what to do instead, or it just reads as broken');
});
