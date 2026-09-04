/**
 * tests/inventory-kits-master.test.js
 *
 * Master kit administration: creating a CHC kit from scratch, editing its
 * lines, curating the brand alternatives a line may be filled with, and
 * switching a kit on or off for many customers in one action. Reads and
 * writes routes/inventory-kits-master.js directly (mounted at /api/admin/kits
 * in the real app) rather than going through routes/admin.js, the same way
 * every other route test in this suite isolates its router.
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
const kitsMaster = require('../routes/inventory-kits-master');

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';

function reset() {
    fake = createFakeSupabase({
        companies: [
            { id: CO_A, name: 'Assured Collision', slug: 'assured', is_active: true },
            { id: CO_B, name: 'Bayview Auto Body', slug: 'bayview', is_active: true }
        ]
    });
    authAdmin = { id: 'aaaaaaaa-1111-4111-8111-111111111111', role: 'super_admin', company_id: null };
}

function app() {
    const a = express();
    a.use(express.json());
    a.use('/api/admin/kits', kitsMaster);
    return a;
}

// ==================================================================
// CREATE / LIST / EDIT / DELETE
// ==================================================================

test('a non-super-admin is refused', async () => {
    reset();
    authAdmin = { id: 'x', role: 'order_desk', company_id: null };
    const res = await request(app()).get('/api/admin/kits');
    assert.equal(res.status, 403);
});

test('creating a master kit writes lines as raw SKU strings, unresolved', async () => {
    reset();
    const res = await request(app()).post('/api/admin/kits').send({
        name: 'Door Skin', description: 'Skin swap',
        lines: [{ sku: 'FUS123EZ', quantity: 0.8 }, { sku: 'FUS208B', quantity: 0.3 }]
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.kit.line_count, 2);
    assert.ok(fake.db.repair_kits.find(k => k.name === 'Door Skin' && k.company_id === null));
});

test('a kit needs a name and at least one line', async () => {
    reset();
    const noName = await request(app()).post('/api/admin/kits').send({ lines: [{ sku: 'X', quantity: 1 }] });
    assert.equal(noName.status, 400);
    const noLines = await request(app()).post('/api/admin/kits').send({ name: 'Empty', lines: [] });
    assert.equal(noLines.status, 400);
});

test('a failed line insert removes the orphan kit header', async () => {
    reset();
    const res = await request(app()).post('/api/admin/kits').send({
        name: 'Bad kit', lines: [{ sku: 'OK', quantity: 1 }, { sku: 'BAD', quantity: -5 }]
    });
    assert.equal(res.status, 400);
    assert.ok(!fake.db.repair_kits.some(k => k.name === 'Bad kit'));
});

test('the list shows master and company kits, with line and enabled-customer counts', async () => {
    reset();
    const master = await request(app()).post('/api/admin/kits').send({ name: 'Door Skin', lines: [{ sku: 'A', quantity: 1 }] });
    await request(app()).put(`/api/admin/kits/${master.body.kit.id}/access/bulk`).send({ company_ids: [CO_A, CO_B], enabled: true });

    const res = await request(app()).get('/api/admin/kits');
    assert.equal(res.status, 200);
    const doorSkin = res.body.kits.find(k => k.name === 'Door Skin');
    assert.equal(doorSkin.is_master, true);
    assert.equal(doorSkin.line_count, 1);
    assert.equal(doorSkin.companies_enabled, 2);
});

test('editing a kit renames it without touching its lines', async () => {
    reset();
    const created = await request(app()).post('/api/admin/kits').send({ name: 'Old name', lines: [{ sku: 'A', quantity: 1 }] });
    const res = await request(app()).put(`/api/admin/kits/${created.body.kit.id}`).send({ name: 'New name', is_active: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.kit.name, 'New name');
    assert.equal(res.body.kit.is_active, false);
    assert.equal(fake.db.kit_items.filter(i => i.kit_id === created.body.kit.id).length, 1);
});

test('a master kit can be deleted from here, unlike the per-company screen', async () => {
    reset();
    const created = await request(app()).post('/api/admin/kits').send({ name: 'Temp', lines: [{ sku: 'A', quantity: 1 }] });
    const res = await request(app()).delete(`/api/admin/kits/${created.body.kit.id}`);
    assert.equal(res.status, 200);
    assert.ok(!fake.db.repair_kits.some(k => k.id === created.body.kit.id));
});

// ==================================================================
// LINES
// ==================================================================

test('a line can be added, edited and removed', async () => {
    reset();
    const created = await request(app()).post('/api/admin/kits').send({ name: 'Kit', lines: [{ sku: 'A', quantity: 1 }] });
    const kitId = created.body.kit.id;

    const added = await request(app()).post(`/api/admin/kits/${kitId}/lines`).send({ sku: 'B', quantity: 2, unit: 'oz' });
    assert.equal(added.status, 201);
    assert.equal(added.body.line.sku, 'B');

    const edited = await request(app()).put(`/api/admin/kits/${kitId}/lines/${added.body.line.id}`).send({ quantity: 5 });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.line.quantity, 5);

    const removed = await request(app()).delete(`/api/admin/kits/${kitId}/lines/${added.body.line.id}`);
    assert.equal(removed.status, 200);
    assert.ok(!fake.db.kit_items.some(i => i.id === added.body.line.id));
});

test('a line quantity must be a positive number', async () => {
    reset();
    const created = await request(app()).post('/api/admin/kits').send({ name: 'Kit', lines: [{ sku: 'A', quantity: 1 }] });
    const res = await request(app()).post(`/api/admin/kits/${created.body.kit.id}/lines`).send({ sku: 'B', quantity: 0 });
    assert.equal(res.status, 400);
});

// ==================================================================
// REFERENCE PRICES AND THE KIT TOTAL
// ==================================================================

test('a reference price can be entered on a line and the extended total is computed', async () => {
    reset();
    const created = await request(app()).post('/api/admin/kits').send({ name: 'Kit', lines: [{ sku: 'A', quantity: 2 }] });
    const lineId = (await request(app()).get(`/api/admin/kits/${created.body.kit.id}`)).body.lines[0].id;

    const edited = await request(app())
        .put(`/api/admin/kits/${created.body.kit.id}/lines/${lineId}`)
        .send({ ref_unit_price: 12.5 });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.line.ref_unit_price, 12.5);
    assert.equal(edited.body.line.ref_line_total, 25, '2 x 12.5');
    assert.equal(edited.body.line.ref_source, 'manual');
});

test('editing quantity after a reference price keeps the extended total in sync', async () => {
    reset();
    const created = await request(app()).post('/api/admin/kits').send({ name: 'Kit', lines: [{ sku: 'A', quantity: 2 }] });
    const lineId = (await request(app()).get(`/api/admin/kits/${created.body.kit.id}`)).body.lines[0].id;

    await request(app()).put(`/api/admin/kits/${created.body.kit.id}/lines/${lineId}`).send({ ref_unit_price: 10 });
    const requantified = await request(app())
        .put(`/api/admin/kits/${created.body.kit.id}/lines/${lineId}`)
        .send({ quantity: 4, ref_unit_price: 10 });
    assert.equal(requantified.body.line.ref_line_total, 40, 'must recompute against the NEW quantity, not the old one');
});

test('sending an explicit null clears a reference price', async () => {
    reset();
    const created = await request(app()).post('/api/admin/kits').send({ name: 'Kit', lines: [{ sku: 'A', quantity: 1 }] });
    const lineId = (await request(app()).get(`/api/admin/kits/${created.body.kit.id}`)).body.lines[0].id;

    await request(app()).put(`/api/admin/kits/${created.body.kit.id}/lines/${lineId}`).send({ ref_unit_price: 10 });
    const cleared = await request(app())
        .put(`/api/admin/kits/${created.body.kit.id}/lines/${lineId}`)
        .send({ ref_unit_price: null });
    assert.equal(cleared.body.line.ref_unit_price, null);
    assert.equal(cleared.body.line.ref_line_total, null);
    assert.equal(cleared.body.line.ref_source, null);
});

test('a negative reference price is refused', async () => {
    reset();
    const created = await request(app()).post('/api/admin/kits').send({ name: 'Kit', lines: [{ sku: 'A', quantity: 1 }] });
    const lineId = (await request(app()).get(`/api/admin/kits/${created.body.kit.id}`)).body.lines[0].id;
    const res = await request(app()).put(`/api/admin/kits/${created.body.kit.id}/lines/${lineId}`).send({ ref_unit_price: -5 });
    assert.equal(res.status, 400);
});

test('the kit detail totals every priced line and counts what is still missing', async () => {
    reset();
    const created = await request(app()).post('/api/admin/kits').send({
        name: 'Kit', lines: [{ sku: 'A', quantity: 2 }, { sku: 'B', quantity: 3 }]
    });
    const kitId = created.body.kit.id;
    const lines = (await request(app()).get(`/api/admin/kits/${kitId}`)).body.lines;

    await request(app()).put(`/api/admin/kits/${kitId}/lines/${lines[0].id}`).send({ ref_unit_price: 10 });
    // B deliberately left unpriced.

    const detail = await request(app()).get(`/api/admin/kits/${kitId}`);
    assert.equal(detail.body.reference_total, null, 'a partial total must not be reported as if it were complete');
    assert.equal(detail.body.unpriced_line_count, 1);

    await request(app()).put(`/api/admin/kits/${kitId}/lines/${lines[1].id}`).send({ ref_unit_price: 4 });
    const complete = await request(app()).get(`/api/admin/kits/${kitId}`);
    // 2 x 10 + 3 x 4 = 32
    assert.equal(complete.body.reference_total, 32);
    assert.equal(complete.body.unpriced_line_count, 0);
});

test('a reference price can be set when a line is first created', async () => {
    reset();
    const created = await request(app()).post('/api/admin/kits').send({ name: 'Kit', lines: [{ sku: 'A', quantity: 1 }] });
    const added = await request(app())
        .post(`/api/admin/kits/${created.body.kit.id}/lines`)
        .send({ sku: 'B', quantity: 5, ref_unit_price: 3 });
    assert.equal(added.status, 201);
    assert.equal(added.body.line.ref_unit_price, 3);
    assert.equal(added.body.line.ref_line_total, 15);
    assert.equal(added.body.line.ref_source, 'manual');
});

// ==================================================================
// BRAND ALTERNATIVES
// ==================================================================

test('an alternative can be attached to a line and later edited or removed', async () => {
    reset();
    const created = await request(app()).post('/api/admin/kits').send({ name: 'Kit', lines: [{ sku: 'FUS208B', quantity: 1 }] });
    const kitId = created.body.kit.id;
    const detail = await request(app()).get(`/api/admin/kits/${kitId}`);
    const lineId = detail.body.lines[0].id;

    const added = await request(app()).post(`/api/admin/kits/${kitId}/lines/${lineId}/alternatives`).send({
        brand: 'Norton', brand_part_number: '06421', brand_name: 'Multi-Purpose Panel Bond'
    });
    assert.equal(added.status, 201);

    const edited = await request(app()).put(`/api/admin/kits/alternatives/${added.body.alternative.id}`).send({ notes: 'Preferred by three shops' });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.alternative.notes, 'Preferred by three shops');

    const removed = await request(app()).delete(`/api/admin/kits/alternatives/${added.body.alternative.id}`);
    assert.equal(removed.status, 200);
    assert.ok(!fake.db.kit_item_alternatives.some(a => a.id === added.body.alternative.id));
});

test('a brand and part number are required to attach an alternative', async () => {
    reset();
    const created = await request(app()).post('/api/admin/kits').send({ name: 'Kit', lines: [{ sku: 'A', quantity: 1 }] });
    const detail = await request(app()).get(`/api/admin/kits/${created.body.kit.id}`);
    const res = await request(app()).post(`/api/admin/kits/${created.body.kit.id}/lines/${detail.body.lines[0].id}/alternatives`).send({ brand: 'Norton' });
    assert.equal(res.status, 400);
});

test('a line with no alternatives yet gets ranked suggestions from the reference sheet', async () => {
    reset();
    fake.db.product_crossover_reference.push({
        id: 'ref-1', base_brand: 'Fusor', base_part_number: 'Fusor 208B',
        alt_brand: 'Norton', alt_part_number: '06421', alt_name: 'Multi-Purpose Panel Bond'
    });
    const created = await request(app()).post('/api/admin/kits').send({ name: 'Kit', lines: [{ sku: 'FUS208B', quantity: 1 }] });
    const detail = await request(app()).get(`/api/admin/kits/${created.body.kit.id}`);
    assert.equal(detail.body.lines[0].suggested_alternatives.length, 1);
    assert.equal(detail.body.lines[0].suggested_alternatives[0].alt_brand, 'Norton');
});

test('a line that already has an alternative attached gets no suggestions', async () => {
    reset();
    fake.db.product_crossover_reference.push({
        id: 'ref-1', base_brand: 'Fusor', base_part_number: 'Fusor 208B', alt_brand: 'Norton', alt_part_number: '06421'
    });
    const created = await request(app()).post('/api/admin/kits').send({ name: 'Kit', lines: [{ sku: 'FUS208B', quantity: 1 }] });
    const detail1 = await request(app()).get(`/api/admin/kits/${created.body.kit.id}`);
    await request(app()).post(`/api/admin/kits/${created.body.kit.id}/lines/${detail1.body.lines[0].id}/alternatives`)
        .send({ brand: 'Norton', brand_part_number: '06421' });

    const detail2 = await request(app()).get(`/api/admin/kits/${created.body.kit.id}`);
    assert.equal(detail2.body.lines[0].alternatives.length, 1);
    assert.equal(detail2.body.lines[0].suggested_alternatives.length, 0);
});

test('kit detail reports is_master the same way the list does', async () => {
    reset();
    const master = await request(app()).post('/api/admin/kits').send({ name: 'Kit', lines: [{ sku: 'A', quantity: 1 }] });
    const detail = await request(app()).get(`/api/admin/kits/${master.body.kit.id}`);
    assert.equal(detail.body.kit.is_master, true);
    assert.equal(detail.body.kit.company_id, null);
});

// ==================================================================
// CUSTOMER ACCESS, IN BULK
// ==================================================================

test('bulk access turns a kit on for every listed company at once', async () => {
    reset();
    const created = await request(app()).post('/api/admin/kits').send({ name: 'Kit', lines: [{ sku: 'A', quantity: 1 }] });
    const res = await request(app()).put(`/api/admin/kits/${created.body.kit.id}/access/bulk`).send({ company_ids: [CO_A, CO_B], enabled: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.applied, 2);

    const list = await request(app()).get(`/api/admin/kits/${created.body.kit.id}/access`);
    assert.ok(list.body.companies.every(c => [CO_A, CO_B].includes(c.company_id) ? c.enabled : true));
});

test('bulk access can turn a kit back off for some companies while leaving others on', async () => {
    reset();
    const created = await request(app()).post('/api/admin/kits').send({ name: 'Kit', lines: [{ sku: 'A', quantity: 1 }] });
    const kitId = created.body.kit.id;
    await request(app()).put(`/api/admin/kits/${kitId}/access/bulk`).send({ company_ids: [CO_A, CO_B], enabled: true });
    await request(app()).put(`/api/admin/kits/${kitId}/access/bulk`).send({ company_ids: [CO_A], enabled: false });

    const list = await request(app()).get(`/api/admin/kits/${kitId}/access`);
    assert.equal(list.body.companies.find(c => c.company_id === CO_A).enabled, false);
    assert.equal(list.body.companies.find(c => c.company_id === CO_B).enabled, true);
});

test('bulk access requires at least one company', async () => {
    reset();
    const created = await request(app()).post('/api/admin/kits').send({ name: 'Kit', lines: [{ sku: 'A', quantity: 1 }] });
    const res = await request(app()).put(`/api/admin/kits/${created.body.kit.id}/access/bulk`).send({ company_ids: [], enabled: true });
    assert.equal(res.status, 400);
});

test('bulk access is refused on a company-owned kit', async () => {
    reset();
    const { data: ownKit } = await fake.from('repair_kits').insert({ company_id: CO_A, name: 'Their kit', source: 'company', is_active: true }).select().single();
    const res = await request(app()).put(`/api/admin/kits/${ownKit.id}/access/bulk`).send({ company_ids: [CO_B], enabled: true });
    assert.equal(res.status, 400);
});
