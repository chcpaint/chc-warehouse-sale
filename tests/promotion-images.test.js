/**
 * tests/promotion-images.test.js
 *
 * A picture uploaded alongside a promotion's item and price: what is accepted,
 * what is refused, that nothing is left half-made, and that the store gets it.
 *
 *   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

// middleware/auth.js is required for real below (to capture its
// implementation before Module._load is overridden — see the file header),
// which transitively requires the real utils/supabase.js. That module exits
// the process if these are unset; the values never have to be reachable
// because supabaseAdmin itself is stubbed out for every actual call.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.invalid';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'service-key';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { createFakeSupabase } = require('./helpers/fake-supabase');

const ROOT = path.resolve(__dirname, '..');
let fake = createFakeSupabase();

const supabaseProxy = new Proxy({}, {
    get: (_t, prop) => {
        const v = fake[prop];
        return typeof v === 'function' ? v.bind(fake) : v;
    }
});

let authAdmin = null;
let authCompany = null;
let authCompanyUser = null;

const sentEmails = { status: [], notes: [], notifications: [] };

// utils/order-scope.js is deliberately NOT stubbed (see file header — real
// requireOrderAccess is what's under test), so it must resolve utils/supabase
// to the fake too. That means the fake has to be wired in via Module._load
// BEFORE middleware/auth.js is ever required — including the require below
// that captures its real implementation — or order-scope's internal
// `require('./supabase')` picks up the genuine client instead and every
// order-scoped call hangs against https://example.invalid.
const stubs = {
    [path.join(ROOT, 'utils/supabase.js')]: { supabaseAdmin: supabaseProxy },
    [path.join(ROOT, 'utils/sanitize.js')]: {
        stripHtml: s => String(s === undefined || s === null ? '' : s).replace(/<[^>]*>/g, ''),
        sanitizeObject: o => o,
        isValidUUID: v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '')),
        generateSlug: s => s,
        validateEmail: () => true
    },
    [path.join(ROOT, 'utils/email.js')]: {
        sendOrderNotification: async (o) => { sentEmails.notifications.push(o); return { sent: true }; },
        sendOrderStatusUpdate: async (o) => { sentEmails.status.push(o); return { sent: true }; },
        sendOrderNoteAdded: async (o) => { sentEmails.notes.push(o); return { sent: true }; },
        sendInvoiceReady: async () => ({ sent: true }),
        sendOrderClosed: async () => ({ sent: true }),
        sendLowStockAlert: async () => ({ sent: true }),
        sendReorderRaised: async () => ({ sent: true }),
        sendInvite: async () => ({ sent: true })
    },
    [path.join(ROOT, 'middleware/upload.js')]: {
        catalogUpload: { single: () => (req, res, next) => next() },
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

// NOW safe to load the real middleware/auth.js — the override above is
// already active, so its internal requires (order-scope -> supabase) land on
// the fake. Captured so the stub added below can carry restrictOrderDesk,
// requireOrderAccess and ORDER_DESK_ALLOW through unmodified, replacing only
// the two entry points that normally verify a JWT.
const realAuth = require('../middleware/auth');
stubs[path.join(ROOT, 'middleware/auth.js')] = {
    ...realAuth,
    requireAdminAuth: (req, res, next) => {
        if (!authAdmin) return res.status(401).json({ error: 'Admin access denied.' });
        req.admin = authAdmin;
        next();
    },
    requireCompanyAuth: (req, res, next) => {
        if (!authCompany) return res.status(401).json({ error: 'Not authenticated.' });
        req.company = authCompany;
        req.companyUser = authCompanyUser;
        next();
    }
};

const express = require('express');
const request = require('supertest');
const adminRoutes = require('../routes/admin');
const storefrontRoutes = require('../routes/storefront');

const CHC_ID = 'c0000000-0000-4000-8000-000000000001';
const CO = '11111111-1111-4111-8111-111111111111';
const BRANCH_MARKHAM = 'd0000000-0000-4000-8000-000000000001';
const BRANCH_OTHER = 'd0000000-0000-4000-8000-000000000002';
const LOC = '33333333-3333-4333-8333-333333333333';
const PRODUCT = '55555555-5555-4555-8555-555555555555';
const ORDER = 'e0000000-0000-4000-8000-000000000001';

const SUPER_ADMIN = { id: 'a1111111-1111-4111-8111-111111111111', role: 'super_admin', name: 'Sam Super', email: 'sam@chc.example', company_id: null, branch_id: null };
const ORDER_DESK_MARKHAM = { id: 'a2222222-2222-4222-8222-222222222222', role: 'order_desk', name: 'Dana Desk', email: 'dana@chc.example', company_id: null, branch_id: BRANCH_MARKHAM };
const ORDER_DESK_OTHER = { id: 'a3333333-3333-4333-8333-333333333333', role: 'order_desk', name: 'Otto Other', email: 'otto@chc.example', company_id: null, branch_id: BRANCH_OTHER };
const ORDER_MANAGER = { id: 'a4444444-4444-4444-8444-444444444444', role: 'order_manager', name: 'Mo Manager', email: 'mo@chc.example', company_id: null, branch_id: null };


const PROMO = 'f2222222-2222-4222-8222-222222222222';
const CO2 = '22222222-2222-4222-8222-222222222222';
const COMPANY_ADMIN = { id: 'a5555555-5555-4555-8555-555555555555', role: 'admin', name: 'Cora Admin', email: 'cora@x.example', company_id: CO, branch_id: null };

// A real 1x1 PNG, a JPEG header, a GIF and a WEBP header: what the byte check looks at.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')]);
const GIF = Buffer.from('GIF89a\x01\0\x01\0\x80\0\0\0\0\0\xff\xff\xff!\xf9\x04\x01\0\0\0\0,\0\0\0\0\x01\0\x01\0\0\x02\x02D\x01\0;', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8 ', 'latin1'), Buffer.alloc(16)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="10" height="10"/></svg>');

function reset(opts = {}) {
    fake = createFakeSupabase({
        distributors: [{ id: CHC_ID, name: 'CHC', slug: 'chc', custom_domain: null, is_active: true, is_default: true, settings: {} }],
        companies: [
            { id: CO, distributor_id: CHC_ID, name: 'Assured', slug: 'assured', is_active: true, contact_email: 'a@x.example', email_config: {}, settings: {} },
            { id: CO2, distributor_id: CHC_ID, name: 'Other', slug: 'other', is_active: true, contact_email: 'o@x.example', email_config: {}, settings: {} }
        ],
        company_locations: [], supplier_branches: [],
        products: [{ id: PRODUCT, company_id: CO, sku: 'W-1', name: 'Widget', brand: '3M', category: 'Abrasives', price: 25, is_active: true, price_on_request: false }],
        promotions: opts.promotions || [], audit_log: []
    });
    authAdmin = SUPER_ADMIN;
    authCompany = { id: CO, name: 'Assured', slug: 'assured' };
    authCompanyUser = null;
}
function adminApp() {
    const a = express();
    a.use(express.json());
    // req.distributor is set directly rather than through the real
    // resolveDistributor middleware — these tests are about what admin.js
    // and storefront.js DO with req.distributor, not host resolution itself
    // (see tests/multi-tenant.test.js for that).
    a.use((req, res, next) => {
        const d = fake.db.distributors[0];
        req.distributor = d ? { id: d.id, name: d.name, slug: d.slug, settings: d.settings } : null;
        next();
    });
    a.use('/api/admin', adminRoutes);
    return a;
}


const fields = (o = {}) => ({ company_id: CO, product_id: PRODUCT, promo_price: '19.99', promo_label: 'Fall sale',
    starts_at: '2026-10-01T00:00:00.000Z', ends_at: '2026-12-31T00:00:00.000Z', ...o });
const postPromo = (img, o = {}, name = 'deal.png', type = 'image/png') => {
    let r = request(adminApp()).post('/api/admin/promotions');
    for (const [k, v] of Object.entries(fields(o))) r = r.field(k, v);
    if (img) r = r.attach('image', img, { filename: name, contentType: type });
    return r;
};
const stored = () => Object.keys(fake.__storage['promotion-images'] || {});

test('a promotion can be created with a picture: stored, URL saved, audit written', async () => {
    reset();
    const res = await postPromo(PNG);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const p = res.body.promotion;
    assert.match(p.image_url, /^https:\/\/.+\/promotion-images\/.+\.png$/);
    assert.equal(stored().length, 1);
    assert.ok(stored()[0].startsWith(p.id + '/'));
    assert.equal(fake.__storage['promotion-images'][stored()[0]].contentType, 'image/png');
    const { data } = await fake.from('audit_log').select('*');
    assert.ok(data.some(a => a.action === 'promotion_created' && a.details.image === true));
});
test('JPEG, GIF and WEBP are accepted, and the type comes from the bytes not the name', async () => {
    for (const [buf, ext, mime] of [[JPEG, 'jpg', 'image/jpeg'], [GIF, 'gif', 'image/gif'], [WEBP, 'webp', 'image/webp']]) {
        reset();
        const res = await postPromo(buf, {}, 'whatever.png', 'application/octet-stream');
        assert.equal(res.status, 201, ext + JSON.stringify(res.body));
        assert.ok(res.body.promotion.image_url.endsWith('.' + ext));
        assert.equal(fake.__storage['promotion-images'][stored()[0]].contentType, mime);
    }
});
test('a promotion with no picture still works as JSON, exactly as before', async () => {
    reset();
    const res = await request(adminApp()).post('/api/admin/promotions').send({ ...fields(), promo_price: 10 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.promotion.image_url, undefined);
    assert.equal(stored().length, 0);
});
test('a file that is not a picture is refused and nothing is created or stored', async () => {
    reset();
    const res = await postPromo(Buffer.from('this is just text pretending to be a picture, long enough'), {}, 'x.png', 'image/png');
    assert.equal(res.status, 400);
    assert.match(res.body.error, /PNG, JPEG, GIF or WEBP/);
    assert.equal(fake.db.promotions.length, 0);
    assert.equal(stored().length, 0);
});
test('SVG is refused (it can carry script)', async () => {
    reset();
    const res = await postPromo(SVG, {}, 'x.svg', 'image/svg+xml');
    assert.equal(res.status, 400);
    assert.equal(fake.db.promotions.length, 0);
});
test('a picture over 3 MB is refused with a plain message', async () => {
    reset();
    const big = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]);
    const res = await postPromo(big);
    assert.equal(res.status, 413);
    assert.match(res.body.error, /3 MB/);
    assert.equal(fake.db.promotions.length, 0);
});
test('if the picture can not be stored, no promotion is left behind', async () => {
    reset();
    fake.__storageFail = 'upstream down';
    const res = await postPromo(PNG);
    assert.equal(res.status, 500);
    assert.equal(fake.db.promotions.length, 0);
});
test('if the bucket is missing the message says to run migration 048', async () => {
    reset();
    fake.__storageFail = 'Bucket not found';
    const res = await postPromo(PNG);
    assert.equal(res.status, 409);
    assert.match(res.body.error, /048/);
});
test('before migration 048 (no image columns) a picture-less create still works and a picture one explains itself', async () => {
    reset();
    const realFrom = fake.from.bind(fake);
    fake.from = (t) => {
        const q = realFrom(t);
        if (t !== 'promotions') return q;
        const ins = q.insert.bind(q);
        q.insert = (row) => (row && ('image_url' in row)
            ? { select: () => ({ single: async () => ({ data: null, error: { message: 'column "image_url" of relation "promotions" does not exist' } }) }) }
            : ins(row));
        return q;
    };
    const ok = await request(adminApp()).post('/api/admin/promotions').send({ ...fields(), promo_price: 10 });
    assert.equal(ok.status, 201);
    const withPic = await postPromo(PNG);
    assert.equal(withPic.status, 409);
    assert.equal(stored().length, 0, 'the uploaded file is cleaned up');
});

test('replacing the picture stores the new one and removes the old file', async () => {
    reset();
    const created = await postPromo(PNG);
    const id = created.body.promotion.id;
    const oldPath = stored()[0];
    const res = await request(adminApp()).put(`/api/admin/promotions/${id}`).attach('image', JPEG, { filename: 'new.jpg', contentType: 'image/jpeg' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.promotion.image_url.endsWith('.jpg'));
    assert.equal(stored().length, 1);
    assert.notEqual(stored()[0], oldPath);
});
test('remove_image takes the picture off and deletes the file; price and label stay', async () => {
    reset();
    const created = await postPromo(PNG);
    const id = created.body.promotion.id;
    const res = await request(adminApp()).put(`/api/admin/promotions/${id}`).send({ remove_image: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.promotion.image_url, null);
    assert.equal(stored().length, 0);
    assert.equal(Number(res.body.promotion.promo_price), 19.99);
});
test('deleting a promotion deletes its picture', async () => {
    reset();
    const created = await postPromo(PNG);
    const res = await request(adminApp()).delete(`/api/admin/promotions/${created.body.promotion.id}`);
    assert.equal(res.status, 200);
    assert.equal(stored().length, 0);
});
test('a company admin can add a picture to their own promotion but not another company\'s', async () => {
    reset({ promotions: [
        { id: PROMO, company_id: CO, product_id: PRODUCT, promo_price: 5, starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-12-31T00:00:00Z', is_active: true },
        { id: 'f3333333-3333-4333-8333-333333333333', company_id: CO2, product_id: PRODUCT, promo_price: 5, starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-12-31T00:00:00Z', is_active: true }
    ] });
    authAdmin = COMPANY_ADMIN;
    const mine = await request(adminApp()).put(`/api/admin/promotions/${PROMO}`).attach('image', PNG, { filename: 'a.png', contentType: 'image/png' });
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    const theirs = await request(adminApp()).put('/api/admin/promotions/f3333333-3333-4333-8333-333333333333').attach('image', PNG, { filename: 'a.png', contentType: 'image/png' });
    assert.equal(theirs.status, 403);
    assert.equal(stored().length, 1);
});
test('an order-desk account can not reach promotions at all', async () => {
    reset();
    authAdmin = ORDER_DESK_MARKHAM;
    const res = await postPromo(PNG);
    assert.ok([401, 403].includes(res.status), String(res.status));
    assert.equal(stored().length, 0);
});

test('the store sends the picture with each promotion', async () => {
    reset({ promotions: [{ id: PROMO, company_id: CO, product_id: PRODUCT, promo_price: 5, promo_label: 'Sale', image_url: 'https://x.example/p.png', image_path: 'a/p.png',
        starts_at: '2020-01-01T00:00:00Z', ends_at: '2099-12-31T00:00:00Z', is_active: true }] });
    const a = express(); a.use(express.json());
    a.use((req, _r, n) => { req.distributor = { id: CHC_ID, settings: {} }; n(); });
    a.use('/api/store', require('../routes/storefront'));
    const res = await request(a).get('/api/store/assured/promotions');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.promotions.length, 1);
    assert.equal(res.body.promotions[0].image_url, 'https://x.example/p.png');
});
