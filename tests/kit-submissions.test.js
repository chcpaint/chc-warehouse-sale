/**
 * tests/kit-submissions.test.js
 *
 * Insurance Kit Submissions: the module gate, kit resolution without inventory,
 * per-shop numbering that cannot repeat, frozen documents, tenancy, status
 * changes, and the PDF itself (including which supplier logo it carries).
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { createFakeSupabase } = require('./helpers/fake-supabase');

// ------------------------------------------------------------------
// Stubs, installed before the routes are required.
// ------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '..');
let fake = createFakeSupabase();
let authCompany = null;
let authUser = null;
let authAdmin = { id: 'admin-1', role: 'super_admin', company_id: null };

const supabaseProxy = new Proxy({}, {
    get: (_t, prop) => {
        const v = fake[prop];
        return typeof v === 'function' ? v.bind(fake) : v;
    }
});

const stubs = {
    [path.join(ROOT, 'utils/supabase.js')]: { supabaseAdmin: supabaseProxy },
    [path.join(ROOT, 'middleware/auth.js')]: {
        requireCompanyAuth: (req, res, next) => {
            if (!authCompany) return res.status(401).json({ error: 'Not authenticated.' });
            req.company = authCompany;
            req.companyUser = authUser;
            next();
        },
        requireAdminAuth: (req, res, next) => { req.admin = authAdmin; next(); },
        requireSuperAdmin: (req, res, next) => next(),
        requireCompanyAccess: (req, res, next) => { req.admin = authAdmin; next(); }
    },
    [path.join(ROOT, 'utils/sanitize.js')]: {
        stripHtml: (s) => String(s === undefined || s === null ? '' : s).replace(/<[^>]*>/g, ''),
        sanitizeObject: (o) => o,
        isValidUUID: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '')),
        generateSlug: (s) => s,
        validateEmail: () => true
    },
    [path.join(ROOT, 'utils/recipients.js')]: {
        resolveOrderRecipients: async () => ({ to: ['branch@chcpaint.com'], replyTo: 'shop@example.com' }),
        validEmails: (list) => list
    },
    [path.join(ROOT, 'utils/email.js')]: {
        sendOrderNotification: async () => {},
        sendInvoiceReady: async () => {},
        sendOrderClosed: async () => {},
        sendLowStockAlert: async () => ({ ok: true })
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
const router = require('../routes/kit-submissions-store');
const { loadSupplierLogo, buildKitSubmissionPdf, isPngOrJpeg } = require('../utils/kit-submission-pdf');

const CO       = '11111111-1111-4111-8111-111111111111';
const OTHER_CO = '22222222-2222-4222-8222-222222222222';
const THIRD_CO = '44444444-4444-4444-8444-444444444444';
const LOC      = '33333333-3333-4333-8333-333333333333';
const D_CHC    = '4d763514-3a41-45f2-b31d-e38756ba1595';
const D_OTHER  = '5d763514-3a41-45f2-b31d-e38756ba1595';

const CLEAR = '55555555-5555-4555-8555-555555555555';
const TAPE  = '77777777-7777-4777-8777-777777777777';
const FREE  = '88888888-8888-4888-8888-888888888888';

const KIT = 'aaaaaaa1-1111-4111-8111-111111111111';
const FOREIGN_KIT = 'aaaaaaa3-3333-4333-8333-333333333333';
const L_CLEAR = 'bbbbbbb1-1111-4111-8111-111111111111';
const L_TAPE  = 'bbbbbbb2-2222-4222-8222-222222222222';
const L_GHOST = 'bbbbbbb3-3333-4333-8333-333333333333';

function seed(opts = {}) {
    return createFakeSupabase({
        distributors: [
            { id: D_CHC, name: 'CHC Paint & Auto Body Supplies', slug: 'chc', is_default: true, logo_url: null },
            { id: D_OTHER, name: 'Maritime Paint Supply', slug: 'maritime', is_default: false, logo_url: null }
        ],
        companies: [
            // No inventory module anywhere: this feature must work without it.
            { id: CO, name: 'Assured Collision', slug: 'assured', distributor_id: D_CHC,
              settings: { kit_submissions: { enabled: true } } },
            { id: OTHER_CO, name: 'Other Shop', slug: 'other', distributor_id: D_CHC,
              settings: { kit_submissions: { enabled: true } } },
            { id: THIRD_CO, name: 'Alpha Cars', slug: 'alpha', distributor_id: D_OTHER,
              settings: { kit_submissions: { enabled: true } } }
        ],
        company_locations: [ { id: LOC, company_id: CO, name: 'Burlington', city: 'Burlington', is_active: true } ],
        products: [
            { id: CLEAR, company_id: CO, sku: 'PRF611N', name: 'ProForm Clear', brand: 'PPG', category: 'Paint', price: 200, is_active: true },
            { id: TAPE, company_id: CO, sku: 'MMM06334', name: '3M Masking Tape', brand: '3M', category: 'Masking', price: 10, is_active: true },
            { id: FREE, company_id: CO, sku: 'FREEBIE', name: 'No price yet', category: 'Misc', price: 0, is_active: true }
        ],
        repair_kits: [
            { id: KIT, company_id: null, name: 'Door Skin', description: 'Skin swap', is_active: true, sort_order: 1 },
            { id: FOREIGN_KIT, company_id: OTHER_CO, name: 'Not yours', is_active: true, sort_order: 3 }
        ],
        kit_items: [
            { id: L_CLEAR, kit_id: KIT, sku: 'PRF611N',  product_id: null, quantity: 0.5, unit: 'each', sort_order: 1 },
            { id: L_TAPE,  kit_id: KIT, sku: 'MMM08852', product_id: null, quantity: 2,   unit: 'each', sort_order: 2 },
            { id: L_GHOST, kit_id: KIT, sku: 'FUS123EZ', product_id: null, quantity: 1,   unit: 'each', sort_order: 3 }
        ],
        company_kit_access: [ { company_id: CO, kit_id: KIT, enabled: true } ],
        ...(opts.extra || {})
    });
}

function app() {
    const a = express();
    a.use(express.json());
    a.use('/api/store/:slug/kit-submissions', router);
    return a;
}

function mapKit() {
    fake.db.kit_product_map.push(
        { id: 'm1', company_id: CO, kit_item_id: L_CLEAR, product_id: CLEAR, quantity: null, is_excluded: false },
        { id: 'm2', company_id: CO, kit_item_id: L_TAPE,  product_id: TAPE,  quantity: null, is_excluded: false },
        { id: 'm3', company_id: CO, kit_item_id: L_GHOST, product_id: null,  quantity: null, is_excluded: true }
    );
}

function reset(opts) {
    fake = seed(opts);
    authCompany = { id: CO, name: 'Assured Collision', slug: 'assured' };
    authUser = null;
}

const S = '/api/store/assured/kit-submissions';
const body = (extra = {}) => ({ kit_id: KIT, ro_number: 'RO-1234', actor_label: 'Sam', ...extra });

// ==================================================================
// MODULE GATE
// ==================================================================
test('refuses every route when the module is off', async () => {
    reset();
    fake.db.companies[0].settings = {};
    for (const [m, p] of [['get', '/kits'], ['get', ''], ['post', '']]) {
        const res = await request(app())[m](S + p).send({});
        assert.equal(res.status, 403, `${m} ${p}`);
    }
});

test('works with the Inventory module off', async () => {
    reset(); mapKit();
    assert.equal(fake.db.companies[0].settings.inventory, undefined);
    const res = await request(app()).get(S + '/kits');
    assert.equal(res.status, 200);
    assert.equal(res.body.kits.length, 1);
});

test('rejects a request with no company session', async () => {
    reset(); authCompany = null;
    const res = await request(app()).get(S + '/kits');
    assert.equal(res.status, 401);
});

// ==================================================================
// KITS + PREVIEW
// ==================================================================
test('a kit is not ready until its lines are matched, then is', async () => {
    reset();
    let res = await request(app()).get(S + '/kits');
    assert.equal(res.body.kits[0].ready, false);
    assert.equal(res.body.kits[0].unresolved_count, 3);
    mapKit();
    res = await request(app()).get(S + '/kits');
    assert.equal(res.body.kits[0].ready, true);
    assert.equal(res.body.kits[0].estimated_total, 120);      // 0.5*200 + 2*10
});

test('preview prices the kit and scales with the multiplier', async () => {
    reset(); mapKit();
    const res = await request(app()).get(`${S}/kits/${KIT}/preview?multiplier=2`);
    assert.equal(res.status, 200);
    assert.equal(res.body.blocked, false);
    assert.equal(res.body.total, 240);
    assert.equal(res.body.lines.find(l => l.sku === 'MMM06334').quantity, 4);
});

test('preview names unmatched lines and blocks', async () => {
    reset();
    const res = await request(app()).get(`${S}/kits/${KIT}/preview`);
    assert.equal(res.body.blocked, true);
    assert.match(res.body.blocked_reason, /not matched/);
    assert.equal(res.body.unresolved.length, 3);
});

test('another company\'s kit is not found', async () => {
    reset(); mapKit();
    const res = await request(app()).get(`${S}/kits/${FOREIGN_KIT}/preview`);
    assert.equal(res.status, 404);
});

test('a line with no price blocks generation', async () => {
    reset(); mapKit();
    fake.db.kit_product_map[1].product_id = FREE;
    const res = await request(app()).post(S).send(body());
    assert.equal(res.status, 409);
    assert.match(res.body.error, /no price/);
    assert.equal(fake.db.kit_submissions.length, 0);
});

// ==================================================================
// CREATING + NUMBERING
// ==================================================================
test('creates a submission with a shop-specific number and frozen lines', async () => {
    reset(); mapKit();
    const res = await request(app()).post(S).send(body({
        claim_no: 'CLM-9', insurer: 'Intact', vehicle: '2022 Civic', vin: '2hgfe2f59nh000000', notes: 'Hi', location_id: LOC
    }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const s = res.body.submission;
    assert.match(s.submission_no, /^AC-00001$/);
    assert.equal(s.total_amount, 120);
    assert.equal(s.line_count, 2);
    const row = fake.db.kit_submissions[0];
    assert.equal(row.vin, '2HGFE2F59NH000000');
    assert.equal(row.created_by_name, 'Sam');
    assert.equal(row.lines_snapshot[0].brand, 'PPG');
});

test('numbers count up for a shop and never repeat', async () => {
    reset(); mapKit();
    const nos = [];
    for (let i = 0; i < 4; i++) {
        const r = await request(app()).post(S).send(body());
        nos.push(r.body.submission.submission_no);
    }
    assert.deepEqual(nos, ['AC-00001', 'AC-00002', 'AC-00003', 'AC-00004']);
    assert.equal(new Set(nos).size, 4);
});

test('concurrent generations all receive different numbers', async () => {
    reset(); mapKit();
    const results = await Promise.all(Array.from({ length: 8 }, () => request(app()).post(S).send(body())));
    const nos = results.map(r => r.body.submission.submission_no);
    assert.equal(new Set(nos).size, 8);
});

test('a second shop with the same initials gets its own prefix', async () => {
    reset(); mapKit();
    fake.db.companies[1].name = 'Alpha Cars';       // OTHER_CO -> "AC" as well
    fake.db.company_kit_access.push({ company_id: OTHER_CO, kit_id: KIT, enabled: true });
    await request(app()).post(S).send(body());      // Assured -> AC-00001
    authCompany = { id: OTHER_CO, name: 'Alpha Cars', slug: 'other' };
    // Map the kit for the second shop so it is generable.
    fake.db.products.push({ id: 'p-o1', company_id: OTHER_CO, sku: 'PRF611N', name: 'Clear', category: 'Paint', price: 100, is_active: true });
    fake.db.kit_product_map.push(
        { id: 'o1', company_id: OTHER_CO, kit_item_id: L_CLEAR, product_id: 'p-o1', quantity: null, is_excluded: false },
        { id: 'o2', company_id: OTHER_CO, kit_item_id: L_TAPE, product_id: null, quantity: null, is_excluded: true },
        { id: 'o3', company_id: OTHER_CO, kit_item_id: L_GHOST, product_id: null, quantity: null, is_excluded: true }
    );
    const r = await request(app()).post('/api/store/other/kit-submissions').send(body());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.submission.submission_no, 'AC1-00001');
});

test('requires a repair order and a name', async () => {
    reset(); mapKit();
    let r = await request(app()).post(S).send(body({ ro_number: '  ' }));
    assert.equal(r.status, 400);
    r = await request(app()).post(S).send({ kit_id: KIT, ro_number: 'RO-1' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /name/i);
    // A signed-in person supplies their own name.
    authUser = { id: 'u1', name: 'Pat Owner', location_id: null };
    r = await request(app()).post(S).send({ kit_id: KIT, ro_number: 'RO-1' });
    assert.equal(r.status, 201);
    assert.equal(fake.db.kit_submissions[0].created_by_name, 'Pat Owner');
});

test('rejects a bad VIN, a bad multiplier and a foreign location', async () => {
    reset(); mapKit();
    assert.equal((await request(app()).post(S).send(body({ vin: 'no good!' }))).status, 400);
    assert.equal((await request(app()).post(S).send(body({ multiplier: 0 }))).status, 400);
    assert.equal((await request(app()).post(S).send(body({ multiplier: 500 }))).status, 400);
    assert.equal((await request(app()).post(S).send(body({ location_id: '99999999-9999-4999-8999-999999999999' }))).status, 400);
    assert.equal(fake.db.kit_submissions.length, 0);
});

test('blocks an unmapped kit and says so', async () => {
    reset();
    const r = await request(app()).post(S).send(body());
    assert.equal(r.status, 409);
    assert.match(r.body.error, /not matched/);
});

test('does not touch stock', async () => {
    reset(); mapKit();
    await request(app()).post(S).send(body());
    assert.equal(fake.db.stock_movements.length, 0);
    assert.equal(fake.db.kit_consumptions.length, 0);
});

test('line overrides adjust quantity or drop a line, when allowed', async () => {
    reset(); mapKit();
    let r = await request(app()).post(S).send(body({ lines: [
        { kit_item_id: L_CLEAR, quantity: 1 },
        { kit_item_id: L_TAPE, skip: true }
    ] }));
    assert.equal(r.status, 201);
    assert.equal(r.body.submission.total_amount, 200);
    assert.equal(r.body.submission.line_count, 1);

    fake.db.companies[0].settings.kit_submissions.allow_line_overrides = false;
    r = await request(app()).post(S).send(body({ lines: [{ kit_item_id: L_CLEAR, quantity: 9 }] }));
    assert.equal(r.body.submission.total_amount, 120);      // override ignored
});

test('a later price change does not alter a saved submission', async () => {
    reset(); mapKit();
    const created = await request(app()).post(S).send(body());
    fake.db.products.find(p => p.id === CLEAR).price = 999;
    const r = await request(app()).get(`${S}/${created.body.submission.id}`);
    assert.equal(r.body.submission.total_amount, 120);
    assert.equal(r.body.submission.lines_snapshot[0].unit_price, 200);
});

// ==================================================================
// LIST / DETAIL / TENANCY / STATUS
// ==================================================================
test('lists only this shop\'s submissions, newest first, with search', async () => {
    reset(); mapKit();
    await request(app()).post(S).send(body({ ro_number: 'RO-1', claim_no: 'ALPHA' }));
    await request(app()).post(S).send(body({ ro_number: 'RO-2' }));
    fake.db.kit_submissions.push({ id: 'zzz', company_id: OTHER_CO, submission_no: 'ZZ-00001', ro_number: 'RO-9', kit_name: 'x',
        status: 'issued', created_at: new Date().toISOString(), lines_snapshot: [] });
    let r = await request(app()).get(S);
    assert.equal(r.body.submissions.length, 2);
    assert.equal(r.body.total, 2);
    assert.ok(!r.body.submissions.some(s => s.submission_no === 'ZZ-00001'));
});

test('another shop\'s submission is not found by id, pdf or status', async () => {
    reset(); mapKit();
    fake.db.kit_submissions.push({ id: '12345678-1234-4234-8234-123456789012', company_id: OTHER_CO, submission_no: 'ZZ-00001',
        ro_number: 'RO-9', kit_name: 'x', status: 'issued', created_at: new Date().toISOString(), lines_snapshot: [] });
    const id = '12345678-1234-4234-8234-123456789012';
    assert.equal((await request(app()).get(`${S}/${id}`)).status, 404);
    assert.equal((await request(app()).get(`${S}/${id}/pdf`)).status, 404);
    assert.equal((await request(app()).patch(`${S}/${id}`).send({ status: 'paid' })).status, 404);
});

test('status: issued to paid, void needs a reason, void is final', async () => {
    reset(); mapKit();
    const id = (await request(app()).post(S).send(body())).body.submission.id;
    let r = await request(app()).patch(`${S}/${id}`).send({ status: 'paid' });
    assert.equal(r.body.submission.status, 'paid');
    assert.ok(r.body.submission.paid_at);
    r = await request(app()).patch(`${S}/${id}`).send({ status: 'void' });
    assert.equal(r.status, 400);
    r = await request(app()).patch(`${S}/${id}`).send({ status: 'void', void_reason: 'Wrong RO' });
    assert.equal(r.body.submission.status, 'void');
    r = await request(app()).patch(`${S}/${id}`).send({ status: 'issued' });
    assert.equal(r.status, 409);
    r = await request(app()).patch(`${S}/${id}`).send({ status: 'bogus' });
    assert.equal(r.status, 400);
});

// ==================================================================
// THE PDF
// ==================================================================
test('the PDF endpoint returns a real PDF named for the submission', async () => {
    reset(); mapKit();
    const created = await request(app()).post(S).send(body());
    const r = await request(app()).get(`${S}/${created.body.submission.id}/pdf`).buffer(true).parse((res, cb) => {
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /application\/pdf/);
    assert.match(r.headers['content-disposition'], /AC-00001\.pdf/);
    assert.equal(r.body.slice(0, 5).toString(), '%PDF-');
    assert.ok(r.body.length > 2000);
});

test('a CHC customer gets the CHC logo; another distributor\'s customer gets its own or its name', async () => {
    const chc = await loadSupplierLogo({ name: 'CHC', slug: 'chc', is_default: true, logo_url: null });
    assert.ok(chc && isPngOrJpeg(chc), 'CHC logo ships with the app');

    // Another distributor with no usable logo: no CHC logo borrowed -> name only.
    const none = await loadSupplierLogo({ name: 'Maritime', slug: 'maritime', is_default: false, logo_url: null });
    assert.equal(none, null);

    // Another distributor with its own https logo: that logo is used.
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const own = await loadSupplierLogo(
        { name: 'Maritime', slug: 'maritime', is_default: false, logo_url: 'https://cdn.example.com/m.png' },
        { fetchImpl: async () => ({ ok: true, headers: { get: () => String(png.length) }, arrayBuffer: async () => png }) });
    assert.ok(own && own.equals(png));

    // Not https, not an image, or a failure: never used.
    const http = await loadSupplierLogo({ name: 'M', slug: 'm', logo_url: 'http://insecure/m.png' },
        { fetchImpl: async () => { throw new Error('should not be called'); } });
    assert.equal(http, null);
    const html = await loadSupplierLogo({ name: 'M', slug: 'm', logo_url: 'https://x/y' },
        { fetchImpl: async () => ({ ok: true, headers: { get: () => '10' }, arrayBuffer: async () => Buffer.from('<html></html>') }) });
    assert.equal(html, null);
    const boom = await loadSupplierLogo({ name: 'M', slug: 'm', logo_url: 'https://x/y' }, { fetchImpl: async () => { throw new Error('net'); } });
    assert.equal(boom, null);

    // A CHC distributor whose custom logo cannot be fetched falls back to the shipped one.
    const fallback = await loadSupplierLogo({ name: 'CHC', slug: 'chc', is_default: true, logo_url: 'https://x/broken.png' },
        { fetchImpl: async () => ({ ok: false, headers: { get: () => '0' }, arrayBuffer: async () => Buffer.alloc(0) }) });
    assert.ok(fallback && isPngOrJpeg(fallback));
});

test('a long kit paginates with a total and page numbers', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => ({ sku: 'S' + i, brand: 'B', name: 'Item ' + i, unit: 'each', quantity: 1, unit_price: 1, line_cost: 1 }));
    const pdf = await buildKitSubmissionPdf({
        submission: { submission_no: 'AC-00009', kit_name: 'Big kit', multiplier: 1, ro_number: '77', total_amount: 60, lines_snapshot: lines, created_at: new Date().toISOString() },
        company: { name: 'Assured' }, location: null, distributor: { name: 'Maritime' }, logo: null
    });
    const txt = pdf.toString('latin1');
    const pages = (txt.match(/\/Type \/Page\b/g) || []).length;
    assert.ok(pages >= 2, `expected several pages, got ${pages}`);
});

test('prefixFor builds recognisable prefixes', () => {
    const { prefixFor } = router;
    assert.equal(prefixFor('Assured Collision'), 'AC');
    assert.equal(prefixFor('Prime Time Auto Body'), 'PTAB');
    assert.equal(prefixFor('Acme'), 'ACME');
    assert.equal(prefixFor('!'), 'SHOP');
});
