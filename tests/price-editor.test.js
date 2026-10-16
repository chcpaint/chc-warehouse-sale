/**
 * tests/price-editor.test.js
 *
 * The per-customer, per-item price editor (routes/price-editor-admin.js,
 * mounted at /api/admin/pricing). Same harness as company-users-admin.test.js;
 * the real restrictOrderDesk allow-list is in the loop, so reachability for
 * order_manager and the refusal of order_desk are both exercised.
 *
 *   node --test tests/*.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.invalid';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'service-key';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { createFakeSupabase } = require('./helpers/fake-supabase');

const ROOT = path.resolve(__dirname, '..');
const fake = createFakeSupabase();

const supabaseProxy = new Proxy({}, {
    get: (_t, prop) => {
        const v = fake[prop];
        return typeof v === 'function' ? v.bind(fake) : v;
    }
});

let authAdmin = null;
const sentInvites = [];

const stubs = {
    [path.join(ROOT, 'utils/supabase.js')]: { supabase: supabaseProxy, supabaseAdmin: supabaseProxy },
    [path.join(ROOT, 'utils/sanitize.js')]: {
        stripHtml: s => String(s === undefined || s === null ? '' : s).replace(/<[^>]*>/g, ''),
        sanitizeObject: o => o,
        isValidUUID: v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '')),
        generateSlug: s => s,
        validateEmail: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || ''))
    },
    [path.join(ROOT, 'utils/email.js')]: {
        sendInvite: async (o) => { sentInvites.push(o); return { sent: true }; },
        sendOrderStatusUpdate: async () => ({ sent: true }),
        sendOrderNoteAdded: async () => ({ sent: true }),
        sendContactNote: async () => ({ sent: true }),
        sendInvoiceReady: async () => ({ sent: true }),
        sendOrderClosed: async () => ({ sent: true })
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

const realAuth = require('../middleware/auth');
stubs[path.join(ROOT, 'middleware/auth.js')] = {
    ...realAuth,
    requireAdminAuth: (req, res, next) => {
        if (!authAdmin) return res.status(401).json({ error: 'Admin access denied.' });
        req.admin = authAdmin;
        next();
    },
    requireCompanyAuth: (req, res, next) => res.status(401).json({ error: 'Not authenticated.' })
};

const express = require('express');
const request = require('supertest');
const adminRoutes = require('../routes/admin');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

function uid(label) {
    const hex = require('node:crypto').createHash('sha1').update(label).digest('hex').slice(0, 12);
    return `bbbbbbbb-cccc-4ddd-8eee-${hex}`;
}

function asSuperAdmin() {
    authAdmin = { id: uid('super-admin'), email: 'adam@chcpaint.com', name: 'Adam', role: 'super_admin', is_active: true, must_change_password: false };
}

function seedCompany(id, name) {
    fake.db.companies = fake.db.companies || [];
    fake.db.companies.push({ id, name, slug: name.toLowerCase(), is_active: true, settings: {} });
}

function seedCompanyUser(id, companyId, patch) {
    fake.db.company_users = fake.db.company_users || [];
    fake.db.company_users.push({
        id, company_id: companyId, email: `${id.slice(-6)}@example.com`, name: id,
        role: 'member', location_id: null, is_active: true, password_hash: 'hash',
        invite_token: null, invite_expires_at: null, created_at: new Date().toISOString(),
        ...patch
    });
}

function asRole(role, extra) {
    authAdmin = { id: uid('admin-' + role), email: role + '@chcpaint.com', name: role, role,
                  company_id: null, is_active: true, must_change_password: false, ...(extra || {}) };
}

function seedCompany(id, name) {
    fake.db.companies = fake.db.companies || [];
    fake.db.companies.push({ id, name, slug: name.toLowerCase(), is_active: true, settings: {} });
}

function seedProduct(id, companyId, patch) {
    fake.db.products = fake.db.products || [];
    fake.db.products.push({
        id, company_id: companyId, brand: 'Norton', name: 'Sanding Disc', sku: 'NRT-100',
        price: 20, previous_price: null, price_on_request: false, case_qty: 1, unit: 'each',
        is_active: true, ...patch
    });
}

function seedLibrary(sku, listPrice, brand) {
    fake.db.item_library = fake.db.item_library || [];
    fake.db.item_library.push({
        id: uid('lib-' + sku), sku, sku_key: sku.replace(/[^A-Za-z0-9]/g, '').toUpperCase(),
        name: sku, brand: brand || 'Norton', list_price: listPrice
    });
}

const put = (co, prod, body) =>
    request(app).put(`/api/admin/pricing/companies/${co}/products/${prod}/price`).send(body);

const stored = id => fake.db.products.find(x => x.id === id);
const lastAudit = () => (fake.db.audit_log || []).at(-1);

test('a super admin sets one customer\'s price; another customer\'s same item is untouched', async () => {
    asRole('super_admin');
    const a = uid('co-iso-a'), b = uid('co-iso-b');
    const pa = uid('p-iso-a'), pb = uid('p-iso-b');
    seedCompany(a, 'Iso A'); seedCompany(b, 'Iso B');
    seedProduct(pa, a, { sku: 'ISO-1', price: 20 });
    seedProduct(pb, b, { sku: 'ISO-1', price: 20 });

    const resp = await put(a, pa, { price: 17.5 });
    assert.equal(resp.status, 200);
    assert.equal(stored(pa).price, 17.5);
    assert.equal(stored(pb).price, 20, 'the other customer must keep their own price');
});

test('the edit is audited with old and new price, who, and why', async () => {
    asRole('super_admin');
    const co = uid('co-audit'), p = uid('p-audit');
    seedCompany(co, 'Audit Co'); seedProduct(p, co, { sku: 'AUD-1', price: 10 });

    const resp = await put(co, p, { price: 9.99, reason: 'Matched competitor' });
    assert.equal(resp.status, 200);
    const log = lastAudit();
    assert.equal(log.action, 'product_price_edited');
    assert.equal(log.admin_id, authAdmin.id);
    assert.equal(log.details.old_price, 10);
    assert.equal(log.details.new_price, 9.99);
    assert.equal(log.details.company_id, co);
    assert.equal(log.details.reason, 'Matched competitor');
});

test('the price rounds to cents and previous_price is left alone', async () => {
    asRole('super_admin');
    const co = uid('co-round'), p = uid('p-round');
    seedCompany(co, 'Round Co'); seedProduct(p, co, { sku: 'RND-1', price: 10, previous_price: 12 });

    const resp = await put(co, p, { price: '8.456' });
    assert.equal(resp.status, 200);
    assert.equal(stored(p).price, 8.46);
    assert.equal(stored(p).previous_price, 12);
});

test('bad prices are refused: blank, zero, negative, text, absurd', async () => {
    asRole('super_admin');
    const co = uid('co-bad'), p = uid('p-bad');
    seedCompany(co, 'Bad Co'); seedProduct(p, co, { sku: 'BAD-1', price: 10 });
    for (const bad of ['', null, 0, -1, 'abc', 5000000]) {
        const resp = await put(co, p, { price: bad });
        assert.equal(resp.status, 400, `price ${JSON.stringify(bad)} should be refused`);
    }
    assert.equal(stored(p).price, 10);
});

test('a product from another customer cannot be priced through this one (404)', async () => {
    asRole('super_admin');
    const a = uid('co-x-a'), b = uid('co-x-b'), p = uid('p-x');
    seedCompany(a, 'X A'); seedCompany(b, 'X B'); seedProduct(p, a, { sku: 'X-1', price: 10 });

    const resp = await put(b, p, { price: 5 });
    assert.equal(resp.status, 404);
    assert.equal(stored(p).price, 10);
});

test('a malformed id is refused', async () => {
    asRole('super_admin');
    const resp = await request(app).put('/api/admin/pricing/companies/nope/products/nope/price').send({ price: 5 });
    assert.equal(resp.status, 400);
});

test('an unchanged price is a no-op, not an audit entry', async () => {
    asRole('super_admin');
    const co = uid('co-same'), p = uid('p-same');
    seedCompany(co, 'Same Co'); seedProduct(p, co, { sku: 'SAME-1', price: 10 });
    const before = (fake.db.audit_log || []).length;

    const resp = await put(co, p, { price: 10 });
    assert.equal(resp.status, 200);
    assert.equal(resp.body.unchanged, true);
    assert.equal((fake.db.audit_log || []).length, before);
});

test('pricing a price-on-request line gives it a real price and clears the flag', async () => {
    asRole('super_admin');
    const co = uid('co-por'), p = uid('p-por');
    seedCompany(co, 'POR Co'); seedProduct(p, co, { sku: 'POR-1', price: 0, price_on_request: true });

    const resp = await put(co, p, { price: 42 });
    assert.equal(resp.status, 200);
    assert.equal(stored(p).price, 42);
    assert.equal(stored(p).price_on_request, false);
});

test('a stale edit is refused when the price changed since the screen loaded it', async () => {
    asRole('super_admin');
    const co = uid('co-stale'), p = uid('p-stale');
    seedCompany(co, 'Stale Co'); seedProduct(p, co, { sku: 'STL-1', price: 15 });

    const resp = await put(co, p, { price: 12, expected_price: 10 });
    assert.equal(resp.status, 409);
    assert.equal(resp.body.code, 'stale');
    assert.equal(resp.body.current_price, 15);
    assert.equal(stored(p).price, 15);
});

// ---- PPG lock --------------------------------------------------------

test('PPG: a different price is refused with the master price named', async () => {
    asRole('super_admin');
    const co = uid('co-ppg1'), p = uid('p-ppg1');
    seedCompany(co, 'PPG One'); seedProduct(p, co, { brand: 'PPG', sku: 'PPG-9001', price: 50 });
    seedLibrary('PPG-9001', 50, 'PPG');

    const resp = await put(co, p, { price: 45 });
    assert.equal(resp.status, 409);
    assert.equal(resp.body.code, 'ppg_locked');
    assert.equal(resp.body.master_price, 50);
    assert.equal(stored(p).price, 50);
});

test('PPG: setting it back to the master price needs no unlock', async () => {
    asRole('order_manager');
    const co = uid('co-ppg2'), p = uid('p-ppg2');
    seedCompany(co, 'PPG Two'); seedProduct(p, co, { brand: 'PPG', sku: 'PPG-9002', price: 44 });
    seedLibrary('PPG-9002', 50, 'PPG');

    const resp = await put(co, p, { price: 50 });
    assert.equal(resp.status, 200);
    assert.equal(stored(p).price, 50);
});

test('PPG: an admin can override with unlock_ppg, for that customer only, and it is audited', async () => {
    asRole('super_admin');
    const a = uid('co-ppg3a'), b = uid('co-ppg3b'), pa = uid('p-ppg3a'), pb = uid('p-ppg3b');
    seedCompany(a, 'PPG 3A'); seedCompany(b, 'PPG 3B');
    seedProduct(pa, a, { brand: 'PPG', sku: 'PPG-9003', price: 50 });
    seedProduct(pb, b, { brand: 'PPG', sku: 'PPG-9003', price: 50 });
    seedLibrary('PPG-9003', 50, 'PPG');

    const resp = await put(a, pa, { price: 46, unlock_ppg: true });
    assert.equal(resp.status, 200);
    assert.equal(stored(pa).price, 46);
    assert.equal(stored(pb).price, 50);
    assert.equal(lastAudit().details.ppg_override, true);
});

test('PPG: an order manager cannot override even by sending unlock_ppg', async () => {
    asRole('order_manager');
    const co = uid('co-ppg4'), p = uid('p-ppg4');
    seedCompany(co, 'PPG Four'); seedProduct(p, co, { brand: 'PPG', sku: 'PPG-9004', price: 50 });
    seedLibrary('PPG-9004', 50, 'PPG');

    const resp = await put(co, p, { price: 40, unlock_ppg: true });
    assert.equal(resp.status, 403);
    assert.equal(resp.body.code, 'ppg_unlock_denied');
    assert.equal(stored(p).price, 50);
});

test('PPG: the lock matches SKUs regardless of punctuation and case', async () => {
    asRole('super_admin');
    const co = uid('co-ppg5'), p = uid('p-ppg5');
    seedCompany(co, 'PPG Five'); seedProduct(p, co, { brand: 'PPG', sku: 'mmm-06652', price: 30 });
    seedLibrary('MMM06652', 30, 'PPG');

    const resp = await put(co, p, { price: 25 });
    assert.equal(resp.status, 409);
    assert.equal(resp.body.code, 'ppg_locked');
});

test('a non-PPG item that is in the library is freely priceable per customer', async () => {
    asRole('order_manager');
    const co = uid('co-np'), p = uid('p-np');
    seedCompany(co, 'Non PPG'); seedProduct(p, co, { sku: 'NRT-555', price: 20 });
    seedLibrary('NRT-555', 20, 'Norton');

    const resp = await put(co, p, { price: 16 });
    assert.equal(resp.status, 200);
    assert.equal(stored(p).price, 16);
});

// ---- price sanity ----------------------------------------------------

test('a price under 15% of list is refused outright (decimal error)', async () => {
    asRole('super_admin');
    const co = uid('co-san1'), p = uid('p-san1');
    seedCompany(co, 'San One'); seedProduct(p, co, { sku: 'SAN-1', price: 100 });
    seedLibrary('SAN-1', 100, 'Rupes');

    const resp = await put(co, p, { price: 9, confirm_outlier: true });
    assert.equal(resp.status, 422);
    assert.equal(resp.body.code, 'price_refused');
    assert.equal(stored(p).price, 100);
});

test('a price 15-30% of list needs explicit confirmation, then saves', async () => {
    asRole('super_admin');
    const co = uid('co-san2'), p = uid('p-san2');
    seedCompany(co, 'San Two'); seedProduct(p, co, { sku: 'SAN-2', price: 100 });
    seedLibrary('SAN-2', 100, 'Rupes');

    const first = await put(co, p, { price: 25 });
    assert.equal(first.status, 409);
    assert.equal(first.body.code, 'needs_confirmation');
    assert.equal(stored(p).price, 100);

    const second = await put(co, p, { price: 25, confirm_outlier: true });
    assert.equal(second.status, 200);
    assert.equal(stored(p).price, 25);
    assert.equal(lastAudit().details.outlier_confirmed, true);
});

test('a price far above list (case vs unit) also needs confirmation', async () => {
    asRole('super_admin');
    const co = uid('co-san3'), p = uid('p-san3');
    seedCompany(co, 'San Three'); seedProduct(p, co, { sku: 'SAN-3', price: 10 });
    seedLibrary('SAN-3', 10, 'Rupes');

    const resp = await put(co, p, { price: 55 });
    assert.equal(resp.status, 409);
    assert.equal(resp.body.code, 'needs_confirmation');
});

test('a normal discount against list saves with no friction', async () => {
    asRole('super_admin');
    const co = uid('co-san4'), p = uid('p-san4');
    seedCompany(co, 'San Four'); seedProduct(p, co, { sku: 'SAN-4', price: 100 });
    seedLibrary('SAN-4', 100, 'Rupes');

    const resp = await put(co, p, { price: 69.99 });
    assert.equal(resp.status, 200);
    assert.equal(resp.body.warning, null);
});

// ---- who may use it --------------------------------------------------

test('order_manager (the operations manager) can list customers and price any of them', async () => {
    asRole('order_manager');
    const a = uid('co-om-a'), b = uid('co-om-b'), pa = uid('p-om-a'), pb = uid('p-om-b');
    seedCompany(a, 'OM A'); seedCompany(b, 'OM B');
    seedProduct(pa, a, { sku: 'OM-1', price: 10 }); seedProduct(pb, b, { sku: 'OM-1', price: 10 });

    const list = await request(app).get('/api/admin/pricing/companies');
    assert.equal(list.status, 200);
    const names = list.body.companies.map(c => c.name);
    assert.ok(names.includes('OM A') && names.includes('OM B'));

    assert.equal((await put(a, pa, { price: 9 })).status, 200);
    assert.equal((await put(b, pb, { price: 8 })).status, 200);
    assert.equal(stored(pa).price, 9);
    assert.equal(stored(pb).price, 8);
});

test('order_desk is refused on every pricing route', async () => {
    asRole('order_desk');
    const co = uid('co-od'), p = uid('p-od');
    seedCompany(co, 'OD Co'); seedProduct(p, co, { sku: 'OD-1', price: 10 });

    assert.equal((await request(app).get('/api/admin/pricing/companies')).status, 403);
    assert.equal((await request(app).get(`/api/admin/pricing/companies/${co}/products`)).status, 403);
    assert.equal((await put(co, p, { price: 5 })).status, 403);
    assert.equal(stored(p).price, 10);
});

test('a company admin can price their own customer only', async () => {
    const mine = uid('co-ca-mine'), other = uid('co-ca-other');
    const pm = uid('p-ca-mine'), po = uid('p-ca-other');
    seedCompany(mine, 'CA Mine'); seedCompany(other, 'CA Other');
    seedProduct(pm, mine, { sku: 'CA-1', price: 10 }); seedProduct(po, other, { sku: 'CA-1', price: 10 });
    asRole('admin', { company_id: mine });

    assert.equal((await put(mine, pm, { price: 9 })).status, 200);
    assert.equal((await put(other, po, { price: 9 })).status, 403);
    assert.equal(stored(po).price, 10);

    const list = await request(app).get('/api/admin/pricing/companies');
    assert.deepEqual(list.body.companies.map(c => c.id), [mine]);
});

test('unauthenticated is refused', async () => {
    authAdmin = null;
    const resp = await request(app).get('/api/admin/pricing/companies');
    assert.equal(resp.status, 401);
});

// ---- listing ---------------------------------------------------------

test('the product list is scoped to the customer and flags PPG locks and list price', async () => {
    asRole('super_admin');
    const a = uid('co-ls-a'), b = uid('co-ls-b');
    seedCompany(a, 'LS A'); seedCompany(b, 'LS B');
    seedProduct(uid('p-ls-1'), a, { name: 'Alpha Clear', brand: 'PPG', sku: 'PPG-7001', price: 60 });
    seedProduct(uid('p-ls-2'), a, { name: 'Beta Disc', sku: 'LS-2', price: 5 });
    seedProduct(uid('p-ls-3'), b, { name: 'Gamma Other Customer', sku: 'LS-3', price: 5 });
    seedLibrary('PPG-7001', 60, 'PPG'); seedLibrary('LS-2', 6, 'Norton');

    const resp = await request(app).get(`/api/admin/pricing/companies/${a}/products`);
    assert.equal(resp.status, 200);
    assert.equal(resp.body.products.length, 2);
    assert.ok(resp.body.products.every(p => p.id !== uid('p-ls-3')));
    const ppg = resp.body.products.find(p => p.sku === 'PPG-7001');
    const plain = resp.body.products.find(p => p.sku === 'LS-2');
    assert.equal(ppg.ppg_locked, true);
    assert.equal(ppg.master_price, 60);
    assert.equal(plain.ppg_locked, false);
    assert.equal(plain.list_price, 6);
    assert.equal(resp.body.can_unlock_ppg, true);
});

test('the product list searches by name or SKU', async () => {
    asRole('order_manager');
    const co = uid('co-srch');
    seedCompany(co, 'Search Co');
    seedProduct(uid('p-srch-1'), co, { name: 'Gold Sanding Disc', sku: 'GSD-1' });
    seedProduct(uid('p-srch-2'), co, { name: 'Masking Tape', sku: 'TAPE-9' });

    const byName = await request(app).get(`/api/admin/pricing/companies/${co}/products?q=sanding`);
    assert.equal(byName.body.products.length, 1);
    const bySku = await request(app).get(`/api/admin/pricing/companies/${co}/products?q=tape-9`);
    assert.equal(bySku.body.products.length, 1);
    assert.equal(bySku.body.can_unlock_ppg, false);
});

// ---- the old back door is closed ------------------------------------

test('the generic product update no longer accepts price fields', async () => {
    asRole('super_admin');
    const co = uid('co-door'), p = uid('p-door');
    seedCompany(co, 'Door Co'); seedProduct(p, co, { brand: 'PPG', sku: 'PPG-8001', price: 50 });

    for (const body of [{ price: 1 }, { previous_price: 99 }, { price_on_request: true }]) {
        const resp = await request(app).put(`/api/admin/companies/${co}/products/${p}`).send(body);
        assert.equal(resp.status, 400);
    }
    assert.equal(stored(p).price, 50);

    const ok = await request(app).put(`/api/admin/companies/${co}/products/${p}`).send({ is_active: false });
    assert.equal(ok.status, 200, 'non-price edits still work');
});
