/**
 * tests/licensing.test.js -- licensing refinishAI to distributors other than CHC.
 *
 * A licensed distributor must see only its own data (orders, staff, branches,
 * Item Library), be paused when its licence is, get links on its own web
 * address, and be capped at its licence's customer limit. CHC, the founding
 * distributor, can never be paused.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { createFakeSupabase } = require('./helpers/fake-supabase');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long';
const ROOT = path.resolve(__dirname, '..');
let fake = createFakeSupabase();
const supabaseProxy = new Proxy({}, { get: (_t, p) => { const v = fake[p]; return typeof v === 'function' ? v.bind(fake) : v; } });
const sent = [];
const stubs = {
    [path.join(ROOT, 'utils/supabase.js')]: { supabaseAdmin: supabaseProxy },
    [path.join(ROOT, 'utils/email.js')]: new Proxy({}, { get: () => async (o) => { sent.push(o); return { sent: true }; } })
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
const { resolveDistributor, invalidateDistributorCache, licenceBlock, appBaseUrl } = require('../utils/tenant');
const { libraryTable } = require('../utils/library-scope');
const orderScope = require('../utils/order-scope');
const distributorsAdmin = require('../routes/distributors-admin');
const adminUsers = require('../routes/admin-users');
const { requireSharedContentEditor } = require('../middleware/auth');
Module._load = originalLoad;

const CHC = 'c0000000-0000-4000-8000-000000000001';
const ACME = 'c0000000-0000-4000-8000-000000000002';
const CHC_CO = 'b0000000-0000-4000-8000-000000000001';
const ACME_CO = 'b0000000-0000-4000-8000-000000000002';
const PLATFORM = { id: 'a0000000-0000-4000-8000-000000000099', role: 'platform_admin', distributor_id: null, name: 'Adam' };
const CHC_SUPER = { id: 'a0000000-0000-4000-8000-000000000001', role: 'super_admin', distributor_id: CHC, name: 'CHC Staff' };
const ACME_SUPER = { id: 'a0000000-0000-4000-8000-000000000002', role: 'super_admin', distributor_id: ACME, name: 'Acme Staff' };

function reset(acme = {}) {
    sent.length = 0;
    fake = createFakeSupabase({
        distributors: [
            { id: CHC, name: 'CHC Paint & Auto Body Supplies', slug: 'chc', custom_domain: 'chcsale.com', is_active: true, is_default: true, licence_status: 'active', short_name: 'CHC' },
            { id: ACME, name: 'Acme Distribution', slug: 'acme', custom_domain: 'orders.acme.example', is_active: true, is_default: false, licence_status: 'active', ...acme }
        ],
        admin_users: [
            { ...CHC_SUPER, email: 'staff@chc.example', is_active: true, password_hash: 'x' },
            { ...ACME_SUPER, email: 'staff@acme.example', is_active: true, password_hash: 'x' },
            { ...PLATFORM, email: 'adam@platform.example', is_active: true, password_hash: 'x' }
        ],
        companies: [
            { id: CHC_CO, distributor_id: CHC, name: 'Assured', slug: 'assured', is_active: true, settings: {} },
            { id: ACME_CO, distributor_id: ACME, name: 'Acme Body', slug: 'acme-body', is_active: true, settings: {} }
        ],
        orders: [
            { id: 'o1', company_id: CHC_CO, distributor_id: CHC, order_number: 'CHC-1', status: 'closed', subtotal: 100, created_at: new Date().toISOString() },
            { id: 'o2', company_id: ACME_CO, distributor_id: ACME, order_number: 'ACM-1', status: 'closed', subtotal: 50, created_at: new Date().toISOString() }
        ],
        item_library: [
            { id: 'l1', distributor_id: CHC, sku: 'MMM02023', sku_key: 'MMM02023', name: '3M Wetordry', list_price: 10 },
            { id: 'l2', distributor_id: ACME, sku: 'MMM02023', sku_key: 'MMM02023', name: '3M Wetordry', list_price: 12 }
        ]
    });
    invalidateDistributorCache();
}

function withAdmin(router, mount, admin) {
    const a = express();
    a.use(express.json());
    a.use(resolveDistributor);
    a.use(mount, (req, res, next) => { req.admin = admin; next(); }, router);
    return a;
}

// ---------------- licence state ----------------
test('a suspended, cancelled or expired-trial licence pauses a distributor; CHC never', () => {
    const today = '2026-11-11';
    assert.equal(licenceBlock({ is_default: false, licence_status: 'active' }, today), null);
    assert.equal(licenceBlock({ is_default: false, licence_status: 'past_due' }, today), null, 'past due is a warning, not a stop');
    assert.equal(licenceBlock({ is_default: false, licence_status: 'suspended' }, today).code, 'licence_inactive');
    assert.equal(licenceBlock({ is_default: false, licence_status: 'cancelled' }, today).code, 'licence_inactive');
    assert.equal(licenceBlock({ is_default: false, licence_status: 'trial', trial_ends_on: '2026-11-10' }, today).code, 'trial_ended');
    assert.equal(licenceBlock({ is_default: false, licence_status: 'trial', trial_ends_on: '2026-11-11' }, today), null);
    assert.equal(licenceBlock({ is_default: true, licence_status: 'suspended' }, today), null);
});

test('a paused distributor\'s address answers 402, except health and help', async () => {
    reset({ licence_status: 'suspended' });
    const a = express();
    a.use(resolveDistributor);
    a.get('/api/store/x/info', (req, res) => res.json({ ok: true }));
    a.get('/api/help/status', (req, res) => res.json({ ok: true }));
    let r = await request(a).get('/api/store/x/info').set('Host', 'orders.acme.example');
    assert.equal(r.status, 402);
    assert.equal(r.body.code, 'licence_inactive');
    r = await request(a).get('/api/help/status').set('Host', 'orders.acme.example');
    assert.equal(r.status, 200);
    r = await request(a).get('/api/store/x/info').set('Host', 'chcsale.com');
    assert.equal(r.status, 200, 'CHC is unaffected');
});

test('links go to the distributor\'s own address', () => {
    const prev = process.env.PLATFORM_DOMAIN;
    delete process.env.PLATFORM_DOMAIN;
    assert.equal(appBaseUrl({ is_default: false, custom_domain: 'Orders.Acme.example', slug: 'acme' }), 'https://orders.acme.example');
    process.env.PLATFORM_DOMAIN = 'refinishai.app';
    assert.equal(appBaseUrl({ is_default: false, custom_domain: null, slug: 'acme' }), 'https://acme.refinishai.app');
    assert.match(appBaseUrl({ is_default: true, custom_domain: 'chcsale.com' }), /^https?:\/\//);
    if (prev === undefined) delete process.env.PLATFORM_DOMAIN; else process.env.PLATFORM_DOMAIN = prev;
});

// ---------------- the platform console ----------------
test('platform console: onboard on a 30-day trial, see usage, invite the first super admin on its own address', async () => {
    reset();
    const app = withAdmin(distributorsAdmin, '/api/admin/platform/distributors', PLATFORM);
    let r = await request(app).post('/api/admin/platform/distributors').set('Host', 'chcsale.com')
        .send({ name: 'Maritime Refinish', custom_domain: 'https://parts.maritime.example/', country: 'CA', licence_fee: 499, licence_term: 'monthly', max_companies: 25 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const d = r.body.distributor;
    assert.equal(d.licence_status, 'trial');
    assert.ok(d.trial_ends_on > new Date().toISOString().slice(0, 10));
    assert.equal(d.custom_domain, 'parts.maritime.example');
    assert.equal(d.address, 'https://parts.maritime.example');

    r = await request(app).get('/api/admin/platform/distributors').set('Host', 'chcsale.com');
    const acme = r.body.distributors.find(x => x.id === ACME);
    assert.equal(acme.usage.companies, 1);
    assert.equal(acme.usage.orders_30d, 1);

    r = await request(app).post(`/api/admin/platform/distributors/${d.id}/admins`).set('Host', 'chcsale.com').send({ name: 'Pat Lee', email: 'pat@maritime.example' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.invite_url, /^https:\/\/parts\.maritime\.example\/set-password\.html\?token=[0-9a-f]{64}&kind=admin$/);
    const created = fake.db.admin_users.find(u => u.email === 'pat@maritime.example');
    assert.equal(created.role, 'super_admin');
    assert.equal(created.distributor_id, d.id);
    assert.ok(fake.db.audit_log.some(a => a.action === 'distributor_admin_invited'));
});

test('platform console: bad input and CHC protections', async () => {
    reset();
    const app = withAdmin(distributorsAdmin, '/api/admin/platform/distributors', PLATFORM);
    let r = await request(app).post('/api/admin/platform/distributors').set('Host', 'chcsale.com').send({ name: 'X', licence_status: 'free-forever' });
    assert.equal(r.status, 400);
    r = await request(app).post('/api/admin/platform/distributors').set('Host', 'chcsale.com').send({ name: 'Y', custom_domain: 'not a domain' });
    assert.equal(r.status, 400);
    r = await request(app).put(`/api/admin/platform/distributors/${CHC}`).set('Host', 'chcsale.com').send({ licence_status: 'suspended' });
    assert.equal(r.status, 409, 'CHC can never be paused');
    r = await request(app).put(`/api/admin/platform/distributors/${ACME}`).set('Host', 'chcsale.com').send({ licence_status: 'suspended', licence_notes: 'unpaid' });
    assert.equal(r.status, 200);
    assert.equal(fake.db.distributors.find(x => x.id === ACME).licence_status, 'suspended');
    const denied = withAdmin(distributorsAdmin, '/api/admin/platform/distributors', CHC_SUPER);
    r = await request(denied).get('/api/admin/platform/distributors').set('Host', 'chcsale.com');
    assert.equal(r.status, 403, 'a distributor\'s own super admin never reaches the platform console');
});

// ---------------- isolation ----------------
test('staff screen: each distributor sees and edits only its own staff', async () => {
    reset();
    const app = withAdmin(adminUsers, '/api/admin/users', ACME_SUPER);
    let r = await request(app).get('/api/admin/users').set('Host', 'orders.acme.example');
    assert.equal(r.status, 200);
    const emails = (r.body.users || r.body.admins || r.body).map(u => u.email);
    assert.deepEqual(emails, ['staff@acme.example']);
    r = await request(app).put(`/api/admin/users/${CHC_SUPER.id}`).set('Host', 'orders.acme.example').send({ name: 'Hacked' });
    assert.equal(r.status, 404);
    assert.equal(fake.db.admin_users.find(u => u.id === CHC_SUPER.id).name, 'CHC Staff');
});

test('orders: a distributor\'s staff are fenced to its own orders once migration 066 is in', async () => {
    reset();
    orderScope.setDistributorColumnReady(true);
    try {
        const req = { admin: ACME_SUPER, distributor: { id: ACME } };
        const { data } = await orderScope.applyOrderScope(fake.from('orders').select('id, order_number'), req, null, null);
        assert.deepEqual(data.map(o => o.order_number), ['ACM-1']);
        assert.equal((await orderScope.orderInScope(req, 'o1')).code, 404, 'CHC\'s order is not found for Acme');
        assert.equal((await orderScope.orderInScope({ admin: CHC_SUPER, distributor: { id: CHC } }, 'o1')).ok, true);
        assert.equal(await orderScope.companyInScope(req, CHC_CO), false);
    } finally {
        orderScope.setDistributorColumnReady(false);
    }
});

test('Item Library: reads see only the distributor\'s rows; writes are stamped with it', async () => {
    reset();
    const { data } = await libraryTable({ distributor: { id: ACME } }).select('id, list_price');
    assert.deepEqual(data.map(r => r.id), ['l2']);
    await libraryTable(ACME).insert({ sku: 'NEW1', sku_key: 'NEW1', name: 'n', distributor_id: CHC });
    assert.equal(fake.db.item_library.find(r => r.sku_key === 'NEW1').distributor_id, ACME, 'a caller cannot write into another distributor');
    await libraryTable(ACME).update({ list_price: 99, distributor_id: CHC }).eq('sku_key', 'MMM02023');
    assert.equal(fake.db.item_library.find(r => r.id === 'l1').list_price, 10, 'CHC\'s row untouched');
    assert.equal(fake.db.item_library.find(r => r.id === 'l2').list_price, 99);
    assert.equal(fake.db.item_library.find(r => r.id === 'l2').distributor_id, ACME);
});

test('shared reference content: other distributors read it; only the platform team edits it', () => {
    const run = (method, admin, distributor) => {
        let code = 0; requireSharedContentEditor({ method, admin, distributor }, { status: c => ({ json: () => { code = c; } }) }, () => { code = 200; });
        return code;
    };
    assert.equal(run('GET', ACME_SUPER, { id: ACME, is_default: false }), 200);
    assert.equal(run('PUT', ACME_SUPER, { id: ACME, is_default: false }), 403);
    assert.equal(run('PUT', CHC_SUPER, { id: CHC, is_default: true }), 200);
    assert.equal(run('DELETE', PLATFORM, { id: ACME, is_default: false }), 200);
});

test('migration 066 labels data without changing it, and fences the library search', () => {
    const sql = require('fs').readFileSync(path.join(ROOT, 'migrations/066_distributor_licensing.sql'), 'utf8');
    assert.match(sql, /join dist on dist\.distributor_id = l\.distributor_id/);
    assert.match(sql, /disable trigger/);
    assert.match(sql, /enable trigger/);
    assert.match(sql, /create trigger trg_orders_set_distributor/);
    assert.ok(!/\bdelete from\b|\bdrop table\b|\btruncate\b/i.test(sql.replace(/--.*$/gm, '')));
});

test('the shop console names its own distributor, not CHC, in labels', () => {
    const html = require('fs').readFileSync(path.join(ROOT, 'public/store.html'), 'utf8');
    assert.match(html, /get label\(\) \{ return 'Contact ' \+ distShort\(\); \}/);
    assert.match(html, /state\.distributor = data\.distributor \|\| null;/);
    assert.ok(!/'Assigned by CHC when you submit'/.test(html));
});

test('web names kept for refinishAI (www, app, api...) cannot be given to a distributor', async () => {
    reset();
    const app = withAdmin(distributorsAdmin, '/api/admin/platform/distributors', PLATFORM);
    for (const slug of ['www', 'app', 'api', 'support']) {
        const r = await request(app).post('/api/admin/platform/distributors').set('Host', 'chcsale.com').send({ name: 'Someone', slug });
        assert.equal(r.status, 400, slug);
    }
    const ok = await request(app).post('/api/admin/platform/distributors').set('Host', 'chcsale.com').send({ name: 'Maritime Refinish', slug: 'maritime' });
    assert.equal(ok.status, 201);
    const prev = process.env.PLATFORM_DOMAIN;
    process.env.PLATFORM_DOMAIN = 'refinishai.com';
    assert.equal(ok.body.distributor.slug, 'maritime');
    assert.equal(appBaseUrl({ is_default: false, custom_domain: null, slug: 'maritime' }), 'https://maritime.refinishai.com');
    if (prev === undefined) delete process.env.PLATFORM_DOMAIN; else process.env.PLATFORM_DOMAIN = prev;
});
