/**
 * tests/scan-exceptions.test.js -- scans that find no item are kept, with a
 * reason, and can be put right (migration 067).
 *
 *   - the reasons: missing barcode, not in catalogue, switched off, misread, unknown
 *   - a repeat scan counts an attempt, it does not make a second issue
 *   - the shop can say how many and what it is, or dismiss; never another shop's
 *   - the distributor puts it right and posts what was on the shelf in one step
 *   - a company admin can dismiss but not change the catalogue
 *   - another distributor's issue is "not found"
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { createFakeSupabase } = require('./helpers/fake-supabase');

const ROOT = path.resolve(__dirname, '..');
let fake = createFakeSupabase();
let authCompany = null;
let authAdmin = null;

const supabaseProxy = new Proxy({}, {
    get: (_t, prop) => { const v = fake[prop]; return typeof v === 'function' ? v.bind(fake) : v; }
});
const stubs = {
    [path.join(ROOT, 'utils/supabase.js')]: { supabaseAdmin: supabaseProxy },
    [path.join(ROOT, 'middleware/auth.js')]: {
        requireCompanyAuth: (req, res, next) => {
            if (!authCompany) return res.status(401).json({ error: 'Not authenticated.' });
            req.company = authCompany; next();
        },
        requireFullAdmin: (req, res, next) => {
            if (!authAdmin || !['super_admin', 'admin'].includes(authAdmin.role)) return res.status(403).json({ error: 'no' });
            req.admin = authAdmin; next();
        },
        requireAdminAuth: (req, res, next) => next(),
        requireSuperAdmin: (req, res, next) => next(),
        requireCompanyAccess: (req, res, next) => next()
    },
    [path.join(ROOT, 'utils/email.js')]: { sendOrderNotification: async () => {} },
    [path.join(ROOT, 'utils/recipients.js')]: { resolveOrderRecipients: async () => ({ to: [] }), validEmails: l => l }
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
const se = require('../utils/scan-exceptions');
const inventoryStore = require('../routes/inventory-store');
const adminRoutes = require('../routes/scan-exceptions-admin');

const DIST = 'd0000000-0000-4000-8000-000000000001';
const OTHER_DIST = 'd0000000-0000-4000-8000-000000000002';
const CO = '11111111-1111-4111-8111-111111111111';
const CO2 = '22222222-2222-4222-8222-222222222222';
const LOC = '33333333-3333-4333-8333-333333333333';
const LOC2 = '44444444-4444-4444-8444-444444444444';
const P_FILM = '55555555-5555-4555-8555-555555555555';
const P_OFF = '66666666-6666-4666-8666-666666666666';
const LIB_FILM = '77777777-7777-4777-8777-777777777777';
const LIB_TONER = '88888888-8888-4888-8888-888888888888';

function reset() {
    fake = createFakeSupabase({
        companies: [
            { id: CO, name: 'Concord', slug: 'concord', distributor_id: DIST, settings: { inventory: { enabled: true, allow_negative: false } } },
            { id: CO2, name: 'Elsewhere', slug: 'elsewhere', distributor_id: OTHER_DIST, settings: { inventory: { enabled: true } } }
        ],
        company_locations: [
            { id: LOC, company_id: CO, name: 'Concord', is_active: true },
            { id: LOC2, company_id: CO2, name: 'Elsewhere', is_active: true }
        ],
        products: [
            { id: P_FILM, company_id: CO, sku: '30669', name: '3M P1000 film disc', is_active: true, price: 10 },
            { id: P_OFF, company_id: CO, sku: 'MMM06652', name: '3M yellow tape 18mm', is_active: false, price: 5 }
        ],
        product_barcodes: [
            { id: 'b-off', product_id: P_OFF, barcode: '051131066526' }
        ],
        item_library: [
            { id: LIB_FILM, distributor_id: DIST, sku: 'MMM30669', name: '3M Hookit Purple Film P1000', brand: '3M', barcode: '051131306691', list_price: 120, is_active: true },
            { id: LIB_TONER, distributor_id: DIST, sku: 'T462', name: 'EHP Fine Red Pearl 1L', brand: 'PPG', barcode: '5025427632691', list_price: 547.43, is_active: true }
        ],
        v_product_master: [
            { product_id: P_FILM, company_id: CO, company_sku: '30669', company_name_for_item: '3M P1000 film disc', master_sku: 'MMM30669', match_type: 'alias', is_active: true }
        ]
    });
    authCompany = { id: CO, name: 'Concord', slug: 'concord' };
    authAdmin = { id: 'a1', role: 'super_admin', distributor_id: DIST, name: 'Adam' };
}

const storeApp = () => { const a = express(); a.use(express.json()); a.use('/api/store/:slug/inventory', inventoryStore); return a; };
const adminApp = () => { const a = express(); a.use(express.json()); a.use('/api/admin/scan-exceptions', adminRoutes); return a; };
const scan = (code, extra = '') => request(storeApp()).get(`/api/store/concord/inventory/lookup?code=${code}&location_id=${LOC}&actor=Sam${extra}`);

// ------------------------------------------------------------------
test('pure: a misread is a numeric barcode-length code with a bad check digit', () => {
    assert.equal(se.isMisread('051131306691'), false);
    assert.equal(se.isMisread('051131306692'), true);
    assert.equal(se.isMisread('ASC1066'), false);
    assert.equal(se.isMisread('12345'), false);
});

test('pure: a case code (GTIN-14) also looks for the single item inside it', () => {
    const inner = se.innerItemCode('10776960077846');
    assert.ok(inner && inner.length === 13);
    assert.equal(se.innerItemCode('051131306691'), null);
    assert.ok(se.lookupForms('10776960077846').includes(inner));
});

test('an unknown code is kept as "Unknown code", with who scanned it and where', async () => {
    reset();
    const r = await scan('999999999993', '&context=count&context_ref=S1&qty=4');
    assert.equal(r.status, 404);
    assert.equal(r.body.exception.reason, 'unknown_code');
    assert.equal(r.body.exception.qty, 4, 'a count scan keeps the counted quantity');
    const row = fake.db.scan_exceptions[0];
    assert.equal(row.company_id, CO); assert.equal(row.location_id, LOC);
    assert.equal(row.actor_label, 'Sam'); assert.equal(row.context, 'count'); assert.equal(row.intended_movement, 'count');
});

test('scanning the same code again counts an attempt rather than making another issue', async () => {
    reset();
    await scan('999999999993'); const r = await scan('999999999993');
    assert.equal(fake.db.scan_exceptions.length, 1);
    assert.equal(r.body.exception.attempts, 2);
});

test('reasons: missing barcode, not in catalogue, switched off and misread', async () => {
    reset();
    const a = await scan('051131306691');
    assert.equal(a.body.exception.reason, 'missing_barcode');
    assert.equal(fake.db.scan_exceptions[0].suggested_product_id, P_FILM, 'found through the library alias');
    const b = await scan('5025427632691');
    assert.equal(b.body.exception.reason, 'not_in_catalog');
    assert.equal(fake.db.scan_exceptions[1].suggested_library_id, LIB_TONER);
    const c = await scan('051131066526');
    assert.equal(c.body.exception.reason, 'inactive_item');
    const d = await scan('051131306692');
    assert.equal(d.body.exception.reason, 'invalid_code');
});

test('a found item records nothing', async () => {
    reset();
    fake.db.product_barcodes.push({ id: 'b2', product_id: P_FILM, barcode: '051131306691' });
    const r = await scan('051131306691');
    assert.equal(r.status, 200);
    assert.equal(fake.db.scan_exceptions.length, 0);
});

test('the shop says how many and what it is, or dismisses; another shop cannot touch it', async () => {
    reset();
    const r = await scan('999999999993');
    const id = r.body.exception.id;
    const p = await request(storeApp()).patch(`/api/store/concord/inventory/scan-exceptions/${id}`).send({ qty: 3, note: 'Norton P400 <b>box</b>' });
    assert.equal(p.status, 200);
    assert.equal(p.body.issue.qty, 3);
    assert.equal(p.body.issue.note, 'Norton P400 box');
    const bad = await request(storeApp()).patch(`/api/store/concord/inventory/scan-exceptions/${id}`).send({ qty: 0 });
    assert.equal(bad.status, 400);

    authCompany = { id: CO2, name: 'Elsewhere', slug: 'elsewhere' };
    const other = await request(storeApp()).patch(`/api/store/elsewhere/inventory/scan-exceptions/${id}`).send({ qty: 9 });
    assert.equal(other.status, 404);
    const list = await request(storeApp()).get('/api/store/elsewhere/inventory/scan-exceptions');
    assert.equal(list.body.issues.length, 0);

    authCompany = { id: CO, name: 'Concord', slug: 'concord' };
    const d = await request(storeApp()).post(`/api/store/concord/inventory/scan-exceptions/${id}/dismiss`).send({ actor_label: 'Sam' });
    assert.equal(d.status, 200);
    assert.equal(fake.db.scan_exceptions[0].status, 'dismissed');
});

test('admin: attach the barcode and post what was received, in one step', async () => {
    reset();
    const r = await scan('051131306691', '&context=receive');
    const id = r.body.exception.id;
    await request(storeApp()).patch(`/api/store/concord/inventory/scan-exceptions/${id}`).send({ qty: 2 });

    const list = await request(adminApp()).get('/api/admin/scan-exceptions');
    assert.equal(list.status, 200);
    assert.equal(list.body.issues.length, 1);
    assert.equal(list.body.issues[0].suggested_product.sku, '30669');

    const res = await request(adminApp()).post(`/api/admin/scan-exceptions/${id}/resolve`).send({ action: 'attach_barcode', stock: 'receive' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(fake.db.product_barcodes.some(b => b.product_id === P_FILM && b.barcode === '051131306691'));
    const mv = fake.db.stock_movements[0];
    assert.equal(mv.qty_change, 2); assert.equal(mv.movement_type, 'receive'); assert.equal(mv.source_doc_type, 'scan_exception');
    assert.equal(fake.db.scan_exceptions[0].status, 'resolved');
    assert.equal(fake.db.scan_exceptions[0].resolution, 'barcode_added');

    // Scanning it now finds the item.
    const again = await scan('051131306691');
    assert.equal(again.status, 200);
});

test('admin: add the Item Library item to the catalogue at list price, with its barcode', async () => {
    reset();
    const r = await scan('5025427632691');
    const res = await request(adminApp()).post(`/api/admin/scan-exceptions/${r.body.exception.id}/resolve`).send({ action: 'add_from_library', stock: 'receive', qty: 1 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const p = fake.db.products.find(x => x.sku === 'T462');
    assert.ok(p); assert.equal(Number(p.price), 547.43); assert.equal(p.company_id, CO);
    assert.ok(fake.db.product_barcodes.some(b => b.product_id === p.id && b.barcode === '5025427632691'));
    assert.equal(fake.db.stock_movements.length, 1);
});

test('admin: taking out more than is on hand is refused before anything changes', async () => {
    reset();
    const r = await scan('051131306691', '&context=kiosk');
    const res = await request(adminApp()).post(`/api/admin/scan-exceptions/${r.body.exception.id}/resolve`).send({ action: 'attach_barcode', stock: 'consume', qty: 5 });
    assert.equal(res.status, 400);
    assert.equal(fake.db.product_barcodes.filter(b => b.product_id === P_FILM).length, 0, 'no barcode attached');
    assert.equal(fake.db.scan_exceptions[0].status, 'open');
});

test('a company admin can dismiss but not change the catalogue; another distributor sees nothing', async () => {
    reset();
    const r = await scan('051131306691');
    const id = r.body.exception.id;

    authAdmin = { id: 'a2', role: 'admin', company_id: CO, name: 'Shop owner' };
    const no = await request(adminApp()).post(`/api/admin/scan-exceptions/${id}/resolve`).send({ action: 'attach_barcode' });
    assert.equal(no.status, 403);
    const list = await request(adminApp()).get('/api/admin/scan-exceptions');
    assert.equal(list.body.can_fix, false);
    assert.equal(list.body.issues.length, 1);

    authAdmin = { id: 'a3', role: 'super_admin', distributor_id: OTHER_DIST, name: 'Other' };
    const hidden = await request(adminApp()).post(`/api/admin/scan-exceptions/${id}/resolve`).send({ action: 'dismiss' });
    assert.equal(hidden.status, 404);
    const theirs = await request(adminApp()).get('/api/admin/scan-exceptions');
    assert.equal(theirs.body.issues.length, 0);

    authAdmin = { id: 'a2', role: 'admin', company_id: CO, name: 'Shop owner' };
    const ok = await request(adminApp()).post(`/api/admin/scan-exceptions/${id}/resolve`).send({ action: 'dismiss' });
    assert.equal(ok.status, 200);
});

test('the kiosk records an unknown scan too, under the badge holder', () => {
    const src = require('fs').readFileSync(path.join(ROOT, 'routes/kiosk.js'), 'utf8');
    assert.match(src, /recordScanException\(\{[\s\S]*context: 'kiosk'/);
    const page = require('fs').readFileSync(path.join(ROOT, 'public/kiosk.html'), 'utf8');
    assert.match(page, /'&badge=' \+ encodeURIComponent\(badge\.code\)/);
    const inv = require('fs').readFileSync(path.join(ROOT, 'public/refinishai-inventory.js'), 'utf8');
    for (const ctx of ['delivery', 'count', 'transfer', 'receive', 'scan']) assert.match(inv, new RegExp(`RAI\\.lookupUrl\\(code, '${ctx}'`));
    // Only the "which of these two items?" follow-up still calls lookup directly; it never misses.
    const direct = inv.match(/inventory\/lookup\?code=/g) || [];
    assert.equal(direct.length, 1, 'only the ambiguous-pick follow-up calls it directly');
});
