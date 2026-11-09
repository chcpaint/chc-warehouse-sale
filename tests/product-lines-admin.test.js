/**
 * tests/product-lines-admin.test.js
 *
 * EHP, OneChoice and Shopline are PPG lines. They must be choosable, and must
 * find their items, on every admin screen that has a brand drop-down: the
 * Products screen, Customer Pricing and the Item Library.
 *
 *   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const fs = require('node:fs');

const { createFakeSupabase } = require('./helpers/fake-supabase');
const ROOT = path.resolve(__dirname, '..');

let fake = createFakeSupabase();
const supabaseProxy = new Proxy({}, {
    get: (_t, prop) => { const v = fake[prop]; return typeof v === 'function' ? v.bind(fake) : v; }
});
const pass = (req, res, next) => next();
const stubs = {
    [path.join(ROOT, 'utils/supabase.js')]: { supabaseAdmin: supabaseProxy },
    // Every auth middleware the admin router asks for is a pass-through here.
    [path.join(ROOT, 'middleware/auth.js')]: new Proxy({}, { get: () => pass })
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
const lines = require('../utils/product-lines');
const libraryRoutes = require('../routes/item-library');
const adminRoutes = require('../routes/admin');

const CO = '11111111-1111-4111-8111-111111111111';
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const prod = (o) => ({ id: uuid(), company_id: CO, price: 10, is_active: true, price_on_request: false, category: 'Paint', ...o });

function seed() {
    fake = createFakeSupabase({
        companies: [{ id: CO, name: 'Assured', slug: 'assured', is_active: true, settings: {} }],
        products: [
            prod({ brand: 'PPG', name: 'EHP Hardener', sku: 'E1' }),
            prod({ brand: 'PPG', name: 'OneChoice Clear', sku: 'OC1' }),
            prod({ brand: 'PPG', name: 'Shop Line Primer', sku: 'SL1' }),
            prod({ brand: 'PPG', name: 'Deltron Base', sku: 'D1' }),
            prod({ brand: '3M', name: 'Disc', sku: 'MMM1' })
        ],
        item_library: [
            { id: uuid(), sku: 'E1', sku_key: 'E1', name: 'EHP Hardener', brand: 'PPG', vendor_code: 'PPG', list_price: null },
            { id: uuid(), sku: 'OC1', sku_key: 'OC1', name: 'OneChoice Clear', brand: 'PPG', vendor_code: 'PPG', list_price: null },
            { id: uuid(), sku: 'SL1', sku_key: 'SL1', name: 'Shopline Primer', brand: 'PPG', vendor_code: 'PPG', list_price: null },
            { id: uuid(), sku: 'D1', sku_key: 'D1', name: 'Deltron Base', brand: 'PPG', vendor_code: 'PPG', list_price: 5 },
            { id: uuid(), sku: 'MMM1', sku_key: 'MMM1', name: '3M Disc', brand: '3M', vendor_code: 'MMM', list_price: 3 }
        ],
        item_library_conflicts: []
    });
}

function libApp() {
    const a = express(); a.use(express.json());
    a.use('/api/admin/companies/:companyId/library', libraryRoutes);
    return a;
}
function adminApp() {
    const a = express(); a.use(express.json());
    a.use('/api/admin', adminRoutes);
    return a;
}

test('helper: a line name is recognised, an ordinary brand is not', () => {
    assert.equal(lines.lineFor('ehp').label, 'EHP');
    assert.equal(lines.lineFor('OneChoice').label, 'OneChoice');
    assert.equal(lines.lineFor('3M'), null);
});

test('helper: line labels become search terms, unknown labels are ignored', () => {
    assert.deepEqual(lines.termsForLabels(['EHP']), ['ehp']);
    assert.ok(lines.termsForLabels(['Shopline', 'nonsense']).includes('shop line'));
    assert.deepEqual(lines.termsForLabels(['x; drop table']), []);
});

test('Products screen filters list the lines beside the brands, with their terms', async () => {
    seed();
    const res = await request(adminApp()).get(`/api/admin/companies/${CO}/products/filters`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.brands, ['3M', 'EHP', 'OneChoice', 'PPG', 'Shopline']);
    assert.deepEqual(res.body.lines.map(l => l.label), ['EHP', 'OneChoice', 'Shopline']);
    assert.ok(res.body.lines.find(l => l.label === 'Shopline').terms.includes('shop line'));
});

test('Products screen: choosing a line lists its items; a plain brand is still exact', async () => {
    seed();
    const get = (q) => request(adminApp()).get(`/api/admin/companies/${CO}/products?${q}`);
    const skus = async (q) => ((await get(q)).body.products || []).map(p => p.sku).sort();
    assert.deepEqual(await skus('brand=EHP'), ['E1']);
    assert.deepEqual(await skus('brand=OneChoice'), ['OC1']);
    assert.deepEqual(await skus('brand=Shopline'), ['SL1']);
    assert.deepEqual(await skus('brand=3M'), ['MMM1']);
});

test('Item Library: searching a line filter returns only that line', async () => {
    seed();
    const res = await request(libApp()).get(`/api/admin/companies/${CO}/library?lines=EHP`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items.map(i => i.sku), ['E1']);
    const two = await request(libApp()).get(`/api/admin/companies/${CO}/library?lines=EHP,Shopline`);
    assert.deepEqual(two.body.items.map(i => i.sku).sort(), ['E1', 'SL1']);
});

test('Item Library: typing the line name in the search box finds its parts', async () => {
    seed();
    const res = await request(libApp()).get(`/api/admin/companies/${CO}/library?q=onechoice`);
    assert.deepEqual(res.body.items.map(i => i.sku), ['OC1']);
});

test('Item Library: an unknown line name is ignored, not passed to the database', async () => {
    seed();
    const res = await request(libApp()).get(`/api/admin/companies/${CO}/library?lines=bogus`);
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 5, 'no filter applied');
});

test('Item Library: the filter list offers the lines that have parts, with counts', async () => {
    seed();
    const res = await request(libApp()).get(`/api/admin/companies/${CO}/library/vendors`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.lines, [
        { label: 'EHP', count: 1 }, { label: 'OneChoice', count: 1 }, { label: 'Shopline', count: 1 }
    ]);
    assert.ok(res.body.vendors.find(v => v.vendor_code === 'PPG'));
});

test('Item Library: a line with no parts is not offered', async () => {
    seed();
    fake.db.item_library = fake.db.item_library.filter(l => !/shopline/i.test(l.name));
    const res = await request(libApp()).get(`/api/admin/companies/${CO}/library/vendors`);
    assert.deepEqual(res.body.lines.map(l => l.label), ['EHP', 'OneChoice']);
});

test('the console wires the lines into the Products drop-down and the Library supplier filter', () => {
    const html = fs.readFileSync(path.join(ROOT, 'admin/index.html'), 'utf8');
    assert.match(html, /productInBrand\(p, brand\)/);
    assert.match(html, /params\.set\('lines'/);
    assert.match(html, /Product lines/);
});

test('migration 057 replaces the old search function and tags what it adds', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'migrations/057_product_lines_in_library.sql'), 'utf8');
    assert.match(sql, /drop function if exists public\.search_item_library\(uuid, text, text\[\], boolean, int, int\)/);
    assert.match(sql, /p_lines\s+text\[\]/);
    assert.match(sql, /catalogue_backfill_lines/);
    assert.doesNotMatch(sql, /on conflict/i, 'the live table has no unique key on sku_key');
    assert.doesNotMatch(sql, /update public\.(products|companies)|delete from public\.(products|companies)/i);
});
