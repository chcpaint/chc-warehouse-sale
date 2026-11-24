/**
 * tests/item-requests.test.js
 *
 * Item requests (migration 072): a customer asks for an item from its store, or
 * CHC staff enter one for a customer who called; the request inbox is emailed;
 * staff close it as Complete (customer told it is ready to order) or Can't
 * supply (customer told why). Through the real store and console routes.
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { createFakeSupabase } = require('./helpers/fake-supabase');

const ROOT = path.resolve(__dirname, '..');
let fake = createFakeSupabase();
let authCompany = null;
let authUser = null;
let admin = null;
const mail = { created: [], closed: [] };

const supabaseProxy = new Proxy({}, {
    get: (_t, prop) => { const v = fake[prop]; return typeof v === 'function' ? v.bind(fake) : v; }
});

const stubs = {
    [path.join(ROOT, 'utils/supabase.js')]: { supabaseAdmin: supabaseProxy },
    [path.join(ROOT, 'middleware/auth.js')]: {
        requireCompanyAuth: (req, res, next) => {
            if (!authCompany) return res.status(401).json({ error: 'Not authenticated.' });
            req.company = authCompany; req.companyUser = authUser; next();
        },
        requireFullAdmin: (req, res, next) => (['super_admin', 'admin'].includes(req.admin.role)
            ? next() : res.status(403).json({ error: 'Full admin only.' })),
        requireAdminAuth: (req, res, next) => next(), requireSuperAdmin: (req, res, next) => next(),
        requireCompanyAccess: (req, res, next) => next(), requireCompanyUser: (req, res, next) => next(),
        requireCompanyOwner: (req, res, next) => next(), restrictOrderDesk: (req, res, next) => next(),
        requireOrderAccess: (req, res, next) => next()
    },
    [path.join(ROOT, 'utils/sanitize.js')]: {
        stripHtml: (s) => String(s === undefined || s === null ? '' : s).replace(/<[^>]*>/g, ''),
        sanitizeObject: (o) => o,
        isValidUUID: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '')),
        generateSlug: (s) => s, validateEmail: () => true
    },
    [path.join(ROOT, 'utils/recipients.js')]: {
        resolveOrderRecipients: async () => ({ to: ['shop@example.invalid'], staffTo: [], customerTo: ['shop@example.invalid'], replyTo: null }),
        validEmails: (l) => l
    },
    [path.join(ROOT, 'utils/email.js')]: {
        sendItemRequestNew: async (o) => { mail.created.push(o); return { sent: true }; },
        sendItemRequestClosed: async (o) => { mail.closed.push(o); return { sent: true }; },
        sendOrderNotification: async () => ({ sent: true }), sendInvoiceReady: async () => {}, sendOrderClosed: async () => {},
        sendLowStockAlert: async () => ({ sent: true }), sendReorderRaised: async () => ({ sent: true }),
        sendOrderNoteAdded: async () => {}, sendContactNote: async () => {}
    },
    [path.join(ROOT, 'utils/order-scope.js')]: {
        isHeadOffice: (r) => ['order_manager', 'sales_director'].includes(r),
        staffDistributorId: () => null,
        staffLocationIds: async (a) => a.loc_ids || [],
        companyInScope: async (req, companyId) => {
            const r = req.admin.role;
            if (r === 'super_admin') return true;
            if (r === 'order_desk') return (req.admin.company_ids || []).includes(companyId);
            return req.admin.company_id === companyId;
        }
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
const storeRouter = require('../routes/item-requests-store');
const adminRouter = require('../routes/item-requests-admin');

const CO = '11111111-1111-4111-8111-111111111111';
const CO2 = '22222222-2222-4222-8222-222222222222';
const LOC = '33333333-3333-4333-8333-333333333333';
const LOC2 = '33333333-3333-4333-8333-333333333334';
const PROD = '55555555-5555-4555-8555-555555555501';
const DIST = '44444444-4444-4444-8444-444444444444';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);

function reset({ inbox = ['adam@chcpaint.com'] } = {}) {
    fake = createFakeSupabase({
        distributors: [{ id: DIST, name: 'CHC Paint', is_default: true, support_email: 'info@chcpaint.com',
            settings: inbox ? { item_requests: { notify_emails: inbox } } : {} }],
        companies: [
            { id: CO, name: 'Concord Collision', slug: 'concord', distributor_id: DIST },
            { id: CO2, name: 'Weins', slug: 'weins', distributor_id: DIST }],
        company_locations: [
            { id: LOC, company_id: CO, name: 'Concord', is_active: true },
            { id: LOC2, company_id: CO2, name: 'Weins 1', is_active: true }],
        products: [{ id: PROD, company_id: CO, sku: 'MMM05887', name: '3M EZ Sand', price: 109.99, is_active: true, price_on_request: false }],
        item_requests: [], audit_log: []
    });
    authCompany = { id: CO, name: 'Concord Collision', slug: 'concord' };
    authUser = null;
    admin = { id: 'a1', role: 'super_admin', name: 'Adam B', email: 'adam@chcpaint.com' };
    mail.created = []; mail.closed = [];
}

function app() {
    const a = express(); a.use(express.json());
    a.use('/api/store/:slug/item-requests', storeRouter);
    a.use('/api/admin/item-requests', (req, res, next) => { req.admin = admin; next(); }, adminRouter);
    return a;
}
const rows = () => fake.db.item_requests;
const tick = () => new Promise(r => setTimeout(r, 20));

// ---------------------------------------------------------------------------
// From the store
// ---------------------------------------------------------------------------

test('a shop asks for an item; it is saved under that customer and the inbox is emailed', async () => {
    reset();
    const r = await request(app()).post('/api/store/concord/item-requests').send({
        item_name: 'Norton SpeedGrip 1 min', part_number: '04615', quantity: '2', notes: 'For bumper repairs',
        location_id: LOC, requested_by_name: 'Pat', requested_by_email: 'Pat@Example.invalid'
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const saved = rows()[0];
    assert.equal(saved.company_id, CO);
    assert.equal(saved.location_id, LOC);
    assert.equal(saved.status, 'open');
    assert.equal(saved.source, 'store');
    assert.equal(saved.requested_by_email, 'pat@example.invalid');
    await tick();
    assert.equal(mail.created.length, 1);
    assert.deepEqual(mail.created[0].to, ['adam@chcpaint.com']);
    assert.equal(mail.created[0].companyName, 'Concord Collision');
    assert.equal(mail.created[0].locationName, 'Concord');
});

test('a request needs an item, and a shop cannot file one under another customer’s location', async () => {
    reset();
    assert.equal((await request(app()).post('/api/store/concord/item-requests').send({ item_name: '  ' })).status, 400);
    assert.equal((await request(app()).post('/api/store/concord/item-requests').send({ item_name: 'Tape', location_id: LOC2 })).status, 400);
    assert.equal((await request(app()).post('/api/store/concord/item-requests').send({ item_name: 'Tape', requested_by_email: 'not-an-email' })).status, 400);
    assert.equal(rows().length, 0);
});

test('photos: up to three real pictures are stored privately and attached to the email; anything else is refused', async () => {
    reset();
    const ok = await request(app()).post('/api/store/concord/item-requests')
        .field('item_name', 'Grey seam sealer').field('location_id', LOC)
        .attach('photos', PNG, 'label.png').attach('photos', PNG, 'can.png');
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.request.photos_saved, 2);
    const stored = Object.keys(fake.__storage['item-request-photos'] || {});
    assert.equal(stored.length, 2);
    assert.ok(stored.every(p => p.startsWith(CO + '/')));
    await tick();
    assert.equal(mail.created[0].photos.length, 2);

    const fakePic = await request(app()).post('/api/store/concord/item-requests')
        .field('item_name', 'Bad').attach('photos', Buffer.from('<svg onload=alert(1)>'), 'x.png');
    assert.equal(fakePic.status, 400);

    const four = await request(app()).post('/api/store/concord/item-requests').field('item_name', 'Many')
        .attach('photos', PNG, 'a.png').attach('photos', PNG, 'b.png').attach('photos', PNG, 'c.png').attach('photos', PNG, 'd.png');
    assert.equal(four.status, 400);
});

test('a shop sees only its own company’s requests, with signed photo links and the linked item once complete', async () => {
    reset();
    fake.db.item_requests.push(
        { id: 'r1', request_no: 7, company_id: CO, location_id: LOC, status: 'complete', item_name: 'EZ Sand', photos: [{ path: `${CO}/r1/1.png`, mime: 'image/png' }],
          product_id: PROD, staff_note: 'Added at $109.99', created_at: '2026-11-20T10:00:00Z' },
        { id: 'r2', request_no: 8, company_id: CO2, location_id: LOC2, status: 'open', item_name: 'Not yours', photos: [], created_at: '2026-11-21T10:00:00Z' });
    const r = await request(app()).get('/api/store/concord/item-requests');
    assert.equal(r.status, 200);
    assert.equal(r.body.requests.length, 1);
    const one = r.body.requests[0];
    assert.equal(one.ref, 'IR-7');
    assert.equal(one.product.sku, 'MMM05887');
    assert.equal(one.staff_note, 'Added at $109.99');
    assert.match(one.photos[0].url, /signed/);
});

test('with no inbox set, requests still reach someone (the distributor’s support address)', async () => {
    reset({ inbox: null });
    await request(app()).post('/api/store/concord/item-requests').send({ item_name: 'Masking tape 2in' });
    await tick();
    assert.deepEqual(mail.created[0].to, ['info@chcpaint.com']);
});

// ---------------------------------------------------------------------------
// In the console
// ---------------------------------------------------------------------------

test('staff enter a request for a customer who called; it is marked as entered by them and the inbox is emailed', async () => {
    reset();
    admin = { id: 'd1', role: 'order_desk', name: 'Desk Dana', email: 'dana@chcpaint.com', company_ids: [CO], loc_ids: [LOC] };
    const r = await request(app()).post('/api/admin/item-requests').send({
        company_id: CO, location_id: LOC, item_name: 'PPG T4034', received_via: 'phone', requested_by_name: 'Louie'
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const saved = rows()[0];
    assert.equal(saved.source, 'staff');
    assert.equal(saved.received_via, 'phone');
    assert.equal(saved.entered_by_name, 'Desk Dana');
    await tick();
    assert.equal(mail.created.length, 1);

    // ...but not for a customer outside their branch.
    const no = await request(app()).post('/api/admin/item-requests').send({ company_id: CO2, item_name: 'X', received_via: 'phone' });
    assert.equal(no.status, 403);
});

test('the console list is scoped to customers the account can see, and counts what is open', async () => {
    reset();
    fake.db.item_requests.push(
        { id: 'r1', request_no: 1, company_id: CO, status: 'open', item_name: 'A', photos: [], created_at: '2026-11-20T10:00:00Z' },
        { id: 'r2', request_no: 2, company_id: CO2, status: 'open', item_name: 'B', photos: [], created_at: '2026-11-21T10:00:00Z' },
        { id: 'r3', request_no: 3, company_id: CO, status: 'complete', item_name: 'C', photos: [], created_at: '2026-11-19T10:00:00Z' });
    const all = await request(app()).get('/api/admin/item-requests?status=open');
    assert.equal(all.body.requests.length, 2);
    assert.equal(all.body.counts.open, 2);
    admin = { id: 'd1', role: 'order_desk', name: 'Desk', company_ids: [CO], loc_ids: [LOC] };
    fake.db.company_locations[0].company_id = CO;
    const desk = await request(app()).get('/api/admin/item-requests?status=all');
    assert.deepEqual(desk.body.requests.map(r => r.item_name).sort(), ['A', 'C']);
});

test('Complete links the item and emails the requester that it is ready to order', async () => {
    reset();
    fake.db.item_requests.push({ id: '66666666-6666-4666-8666-666666666601', request_no: 12, company_id: CO, location_id: LOC,
        status: 'open', item_name: 'EZ Sand', requested_by_email: 'pat@example.invalid', photos: [], created_at: '2026-11-20T10:00:00Z' });
    const r = await request(app()).put('/api/admin/item-requests/66666666-6666-4666-8666-666666666601')
        .send({ status: 'complete', product_id: PROD, staff_note: 'Added at $109.99' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.notified, true);
    const row = rows()[0];
    assert.equal(row.status, 'complete');
    assert.equal(row.product_id, PROD);
    assert.equal(row.closed_by_name, 'Adam B');
    assert.ok(row.customer_notified_at);
    assert.equal(mail.closed.length, 1);
    assert.deepEqual(mail.closed[0].to, ['pat@example.invalid']);
    assert.equal(mail.closed[0].outcome, 'complete');
    assert.equal(mail.closed[0].product.sku, 'MMM05887');
    assert.match(mail.closed[0].storeUrl, /\/store\/concord$/);
});

test('Can’t supply needs a reason; with no requester email the shop’s contacts are told; an item from another customer cannot be linked', async () => {
    reset();
    fake.db.item_requests.push({ id: '66666666-6666-4666-8666-666666666602', request_no: 13, company_id: CO, status: 'open',
        item_name: 'Discontinued thing', photos: [], created_at: '2026-11-20T10:00:00Z' });
    const url = '/api/admin/item-requests/66666666-6666-4666-8666-666666666602';
    assert.equal((await request(app()).put(url).send({ status: 'cannot_supply' })).status, 400);
    fake.db.products.push({ id: '55555555-5555-4555-8555-555555555599', company_id: CO2, sku: 'X', name: 'Other customer item', is_active: true });
    assert.equal((await request(app()).put(url).send({ status: 'complete', product_id: '55555555-5555-4555-8555-555555555599' })).status, 400);
    const r = await request(app()).put(url).send({ status: 'cannot_supply', staff_note: 'Discontinued by the maker.' });
    assert.equal(r.status, 200);
    assert.deepEqual(mail.closed[0].to, ['shop@example.invalid']);
    assert.equal(mail.closed[0].staffNote, 'Discontinued by the maker.');
});

test('the inbox list: anyone sees it, only a full admin changes it, and it must hold real addresses', async () => {
    reset();
    const g = await request(app()).get('/api/admin/item-requests/settings');
    assert.deepEqual(g.body.notify_emails, ['adam@chcpaint.com']);
    assert.equal((await request(app()).put('/api/admin/item-requests/settings').send({ notify_emails: 'adam@chcpaint.com, nope' })).status, 400);
    assert.equal((await request(app()).put('/api/admin/item-requests/settings').send({ notify_emails: '' })).status, 400);
    const ok = await request(app()).put('/api/admin/item-requests/settings').send({ notify_emails: 'adam@chcpaint.com, Daniel@chcpaint.com' });
    assert.equal(ok.status, 200);
    assert.deepEqual(fake.db.distributors[0].settings.item_requests.notify_emails, ['adam@chcpaint.com', 'daniel@chcpaint.com']);
    admin = { id: 'd1', role: 'order_desk', name: 'Desk' };
    assert.equal((await request(app()).put('/api/admin/item-requests/settings').send({ notify_emails: 'x@y.com' })).status, 403);
});

test('the sidebar badge counts waiting requests for the customers this account can see', async () => {
    reset();
    fake.db.item_requests.push(
        { id: '66666666-6666-4666-8666-666666666611', request_no: 21, company_id: CO, status: 'open', item_name: 'A', photos: [], created_at: '2026-11-20T10:00:00Z' },
        { id: '66666666-6666-4666-8666-666666666612', request_no: 22, company_id: CO, status: 'complete', item_name: 'B', photos: [], created_at: '2026-11-20T10:00:00Z' },
        { id: '66666666-6666-4666-8666-666666666613', request_no: 23, company_id: CO2, status: 'open', item_name: 'C', photos: [], created_at: '2026-11-20T10:00:00Z' });
    const all = await request(app()).get('/api/admin/item-requests/count');
    assert.equal(all.status, 200);
    assert.equal(all.body.open, 2);
    admin = { id: 'a2', role: 'admin', name: 'Shop admin', company_id: CO2 };
    assert.equal((await request(app()).get('/api/admin/item-requests/count')).body.open, 1);
});
