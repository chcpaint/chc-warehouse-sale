/**
 * tests/crossover-reference-admin.test.js
 *
 * The brand-crossover reference sheet's admin API: searching it while
 * curating a kit line's alternatives, and re-importing a new sheet when CHC
 * gets one. The multer upload middleware itself is real (no supabase
 * dependency), the same way master-table.test.js exercises catalogUpload.
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
const crossoverAdmin = require('../routes/crossover-reference-admin');

function reset() {
    fake = createFakeSupabase();
    authAdmin = { id: 'aaaaaaaa-1111-4111-8111-111111111111', role: 'super_admin', company_id: null };
}

function app() {
    const a = express();
    a.use(express.json());
    a.use('/api/admin/crossover', crossoverAdmin);
    return a;
}

/** A minimal Norton-sheet workbook shaped like the real one. */
function crossoverWorkbook() {
    const wb = XLSX.utils.book_new();
    const rows = [
        ['Fusor', null, null, null, 'Norton SpeedGrip'],
        ['Name', 'Part #', 'Speed', 'Size', 'Name', 'Part #', 'Speed', 'Size'],
        ['METAL BONDING ADHESIVES'],
        ['Metal Bonding Adhesive', 'Fusor 208B', 'Slow', '210ml', 'Multi-Purpose Panel Bond', 6421, 'Slow', '220ml']
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Norton Speed Grip');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('a non-super-admin is refused', async () => {
    reset();
    authAdmin = { id: 'x', role: 'order_desk', company_id: null };
    const res = await request(app()).get('/api/admin/crossover/search');
    assert.equal(res.status, 403);
});

test('importing a recognised sheet loads its crossover rows', async () => {
    reset();
    const res = await request(app())
        .post('/api/admin/crossover/import')
        .attach('file', crossoverWorkbook(), 'norton.xlsx');
    assert.equal(res.status, 201);
    assert.equal(res.body.imported, 1);
    assert.equal(res.body.by_brand.Norton, 1);
    assert.equal(fake.db.product_crossover_reference.length, 1);
    assert.equal(fake.db.product_crossover_reference[0].alt_part_number, '6421');
});

test('a file with no recognised sheet names is refused rather than silently importing nothing', async () => {
    reset();
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([['just', 'some', 'data']]);
    XLSX.utils.book_append_sheet(wb, ws, 'Random Sheet');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const res = await request(app()).post('/api/admin/crossover/import').attach('file', buf, 'random.xlsx');
    assert.equal(res.status, 400);
});

test('importing with no file is refused', async () => {
    reset();
    const res = await request(app()).post('/api/admin/crossover/import');
    assert.equal(res.status, 400);
});

test('search matches on either the Fusor side or the alternative side', async () => {
    reset();
    fake.db.product_crossover_reference.push(
        { id: 'r1', base_part_number: 'Fusor 208B', base_name: 'Metal Bonding Adhesive', alt_brand: 'Norton', alt_name: 'Multi-Purpose Panel Bond', alt_part_number: '06421' },
        { id: 'r2', base_part_number: 'Fusor 141/140', base_name: 'Clear Plastic Bonding Adhesive', alt_brand: '3M', alt_name: 'Universal Adhesive', alt_part_number: '08214' }
    );

    const byFusor = await request(app()).get('/api/admin/crossover/search?q=208B');
    assert.equal(byFusor.body.results.length, 1);
    assert.equal(byFusor.body.results[0].id, 'r1');

    const byAlt = await request(app()).get('/api/admin/crossover/search?q=08214');
    assert.equal(byAlt.body.results.length, 1);
    assert.equal(byAlt.body.results[0].id, 'r2');
});

test('search can be narrowed to one brand', async () => {
    reset();
    fake.db.product_crossover_reference.push(
        { id: 'r1', base_part_number: 'Fusor 208B', alt_brand: 'Norton', alt_part_number: '06421' },
        { id: 'r2', base_part_number: 'Fusor 208B', alt_brand: '3M', alt_part_number: '08115' }
    );
    const res = await request(app()).get('/api/admin/crossover/search?brand=3M');
    assert.equal(res.body.results.length, 1);
    assert.equal(res.body.results[0].alt_brand, '3M');
});

test('brands lists each brand once with a row count', async () => {
    reset();
    fake.db.product_crossover_reference.push(
        { id: 'r1', alt_brand: 'Norton' }, { id: 'r2', alt_brand: 'Norton' }, { id: 'r3', alt_brand: '3M' }
    );
    const res = await request(app()).get('/api/admin/crossover/brands');
    assert.deepEqual(res.body.brands, [{ brand: '3M', count: 1 }, { brand: 'Norton', count: 2 }]);
});

test('a reference row can be deleted', async () => {
    reset();
    fake.db.product_crossover_reference.push({ id: 'r1', alt_brand: 'Norton' });
    const res = await request(app()).delete('/api/admin/crossover/r1');
    assert.equal(res.status, 200);
    assert.equal(fake.db.product_crossover_reference.length, 0);
});
