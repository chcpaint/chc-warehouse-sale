/**
 * tests/multi-tenant.test.js
 *
 * The distributor tenancy layer added in migration 037: resolving a request
 * to a distributor from its Host header (utils/tenant.js), the login and
 * auth-middleware enforcement that keeps one distributor's accounts and
 * companies from reaching another's (routes/auth.js, middleware/auth.js),
 * and the platform_admin-only distributor management API
 * (routes/distributors-admin.js).
 *
 * Unlike most of this suite, these tests do NOT stub middleware/auth.js or
 * utils/tenant.js -- the whole point is to exercise the real enforcement,
 * not a pass-through fake of it. Only utils/supabase.js is stubbed, exactly
 * as elsewhere, so everything runs against the fake in-memory database.
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { createFakeSupabase } = require('./helpers/fake-supabase');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long';

const ROOT = path.resolve(__dirname, '..');
let fake = createFakeSupabase();

const supabaseProxy = new Proxy({}, {
    get: (_t, prop) => {
        const v = fake[prop];
        return typeof v === 'function' ? v.bind(fake) : v;
    }
});

const stubs = {
    [path.join(ROOT, 'utils/supabase.js')]: { supabaseAdmin: supabaseProxy },
    [path.join(ROOT, 'utils/sanitize.js')]: {
        stripHtml: (s) => String(s === undefined || s === null ? '' : s).replace(/<[^>]*>/g, ''),
        sanitizeObject: (o) => o,
        isValidUUID: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '')),
        generateSlug: (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
        validateEmail: (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''))
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
const { resolveDistributor, invalidateDistributorCache } = require('../utils/tenant');
const { requireAdminAuth, requirePlatformAdmin } = require('../middleware/auth');
const authRoutes = require('../routes/auth');
const distributorsAdmin = require('../routes/distributors-admin');

// ------------------------------------------------------------------
// Fixtures: two distributors, each with a company sharing the SAME slug --
// exactly the case a single global "companies.slug" uniqueness could not
// have allowed before migration 037, and that a routing bug would leak
// across.
// ------------------------------------------------------------------

const CHC_ID = 'c0000000-0000-4000-8000-000000000001';
const ACME_ID = 'c0000000-0000-4000-8000-000000000002';

const CHC_ADMIN_ID = 'a0000000-0000-4000-8000-000000000001';
const ACME_ADMIN_ID = 'a0000000-0000-4000-8000-000000000002';
const PLATFORM_ADMIN_ID = 'a0000000-0000-4000-8000-000000000099';

const CHC_COMPANY_ID = 'b0000000-0000-4000-8000-000000000001';
const ACME_COMPANY_ID = 'b0000000-0000-4000-8000-000000000002';

const PASSWORD = 'Sup3rSecret';
const passwordHash = bcrypt.hashSync(PASSWORD, 4);

function reset() {
    fake = createFakeSupabase({
        distributors: [
            { id: CHC_ID, name: 'CHC Paint & Auto Body Supplies', slug: 'chc', custom_domain: 'chcsale.com', is_active: true, is_default: true },
            { id: ACME_ID, name: 'Acme Distribution', slug: 'acme', custom_domain: null, is_active: true, is_default: false }
        ],
        admin_users: [
            {
                id: CHC_ADMIN_ID, email: 'staff@chc.example', name: 'CHC Staff', role: 'super_admin',
                distributor_id: CHC_ID, company_id: null, branch_id: null, password_hash: passwordHash,
                is_active: true, must_change_password: false, is_branch_manager: false
            },
            {
                id: ACME_ADMIN_ID, email: 'staff@acme.example', name: 'Acme Staff', role: 'super_admin',
                distributor_id: ACME_ID, company_id: null, branch_id: null, password_hash: passwordHash,
                is_active: true, must_change_password: false, is_branch_manager: false
            },
            {
                id: PLATFORM_ADMIN_ID, email: 'adam@platform.example', name: 'Adam', role: 'platform_admin',
                distributor_id: null, company_id: null, branch_id: null, password_hash: passwordHash,
                is_active: true, must_change_password: false, is_branch_manager: false
            }
        ],
        companies: [
            {
                id: CHC_COMPANY_ID, distributor_id: CHC_ID, name: 'Assured Collision', slug: 'assured',
                access_code: bcrypt.hashSync('chc-code', 4), logo_url: null, is_active: true, settings: {}
            },
            {
                id: ACME_COMPANY_ID, distributor_id: ACME_ID, name: 'Acme Body Shop', slug: 'assured', // same slug, different distributor
                access_code: bcrypt.hashSync('acme-code', 4), logo_url: null, is_active: true, settings: {}
            }
        ]
    });
    invalidateDistributorCache();
}

function appWithHost() {
    const a = express();
    a.use(express.json());
    a.use(resolveDistributor);
    a.use('/api/auth', authRoutes);
    // A minimal protected echo, standing in for the rest of /api/admin --
    // just enough to prove requireAdminAuth enforces the distributor match.
    a.get('/api/admin/whoami-echo', requireAdminAuth, (req, res) => res.json({ admin_id: req.admin.id, role: req.admin.role }));
    return a;
}

function platformApp() {
    const a = express();
    a.use(express.json());
    a.use(resolveDistributor);
    a.use('/api/admin/platform/distributors', (req, res, next) => {
        // Stand in for requireAdminAuth having already run and attached
        // req.admin -- this suite tests distributors-admin.js's own logic,
        // not requireAdminAuth's (covered above), by injecting whichever
        // admin role the test wants to check.
        req.admin = a.locals.testAdmin;
        next();
    }, distributorsAdmin);
    return a;
}

// ==================================================================
// utils/tenant.js -- resolution
// ==================================================================

test('a request on CHC\'s custom domain resolves to CHC', async () => {
    reset();
    const res = await request(appWithHost()).get('/api/admin/whoami-echo').set('Host', 'chcsale.com');
    // No token -> 401, but that still proves resolveDistributor ran without
    // erroring and reached requireAdminAuth; the resolution itself is
    // exercised end-to-end by the login tests below.
    assert.equal(res.status, 401);
});

test('an unmatched host falls back to the default distributor (CHC)', async () => {
    reset();
    const login = await request(appWithHost())
        .post('/api/auth/admin-login')
        .set('Host', 'chc-sale-console-production.up.railway.app')
        .send({ email: 'staff@chc.example', password: PASSWORD });
    assert.equal(login.status, 200);
    assert.equal(login.body.admin.distributor_id, CHC_ID);
});

test('with PLATFORM_DOMAIN configured, a distributor\'s slug subdomain resolves to it', async () => {
    reset();
    process.env.PLATFORM_DOMAIN = 'platform.example';
    invalidateDistributorCache();
    try {
        const login = await request(appWithHost())
            .post('/api/auth/admin-login')
            .set('Host', 'acme.platform.example')
            .send({ email: 'staff@acme.example', password: PASSWORD });
        assert.equal(login.status, 200);
        assert.equal(login.body.admin.distributor_id, ACME_ID);
    } finally {
        delete process.env.PLATFORM_DOMAIN;
        invalidateDistributorCache();
    }
});

test('deactivating the default distributor leaves unmatched hosts with a clean 503, not a crash', async () => {
    reset();
    fake.db.distributors.find(d => d.id === CHC_ID).is_active = false;
    invalidateDistributorCache();
    const res = await request(appWithHost()).get('/api/admin/whoami-echo').set('Host', 'nowhere.example');
    assert.equal(res.status, 503);
});

// ==================================================================
// Company login -- slug is unique per distributor, not globally
// ==================================================================

test('company-login on CHC\'s domain finds CHC\'s "assured", not Acme\'s', async () => {
    reset();
    const res = await request(appWithHost())
        .post('/api/auth/company-login')
        .set('Host', 'chcsale.com')
        .send({ slug: 'assured', access_code: 'chc-code' });
    assert.equal(res.status, 200);
    assert.equal(res.body.company.id, CHC_COMPANY_ID);
});

test('the same slug on Acme\'s access code fails against CHC\'s domain', async () => {
    reset();
    const res = await request(appWithHost())
        .post('/api/auth/company-login')
        .set('Host', 'chcsale.com')
        .send({ slug: 'assured', access_code: 'acme-code' }); // right code, wrong distributor's company
    assert.equal(res.status, 401);
});

test('company-login on Acme\'s subdomain finds Acme\'s "assured" instead', async () => {
    reset();
    process.env.PLATFORM_DOMAIN = 'platform.example';
    invalidateDistributorCache();
    try {
        const res = await request(appWithHost())
            .post('/api/auth/company-login')
            .set('Host', 'acme.platform.example')
            .send({ slug: 'assured', access_code: 'acme-code' });
        assert.equal(res.status, 200);
        assert.equal(res.body.company.id, ACME_COMPANY_ID);
    } finally {
        delete process.env.PLATFORM_DOMAIN;
        invalidateDistributorCache();
    }
});

// ==================================================================
// Admin login + requireAdminAuth -- cross-distributor enforcement
// ==================================================================

test('an Acme admin cannot log in while resolved to CHC\'s domain', async () => {
    reset();
    const res = await request(appWithHost())
        .post('/api/auth/admin-login')
        .set('Host', 'chcsale.com')
        .send({ email: 'staff@acme.example', password: PASSWORD });
    assert.equal(res.status, 401);
    assert.match(res.body.error, /Invalid email or password/);
});

test('platform_admin can log in from any distributor\'s domain', async () => {
    reset();
    const res = await request(appWithHost())
        .post('/api/auth/admin-login')
        .set('Host', 'chcsale.com')
        .send({ email: 'adam@platform.example', password: PASSWORD });
    assert.equal(res.status, 200);
    assert.equal(res.body.admin.role, 'platform_admin');
});

test('a token minted for CHC is refused on a request that resolves to Acme', async () => {
    reset();
    const app = appWithHost();
    const login = await request(app)
        .post('/api/auth/admin-login')
        .set('Host', 'chcsale.com')
        .send({ email: 'staff@chc.example', password: PASSWORD });
    assert.equal(login.status, 200);
    const token = login.body.token;

    process.env.PLATFORM_DOMAIN = 'platform.example';
    invalidateDistributorCache();
    try {
        const echo = await request(app)
            .get('/api/admin/whoami-echo')
            .set('Host', 'acme.platform.example')
            .set('Authorization', `Bearer ${token}`);
        assert.equal(echo.status, 401);
    } finally {
        delete process.env.PLATFORM_DOMAIN;
        invalidateDistributorCache();
    }
});

test('that same CHC token still works back on CHC\'s own domain', async () => {
    reset();
    const app = appWithHost();
    const login = await request(app)
        .post('/api/auth/admin-login')
        .set('Host', 'chcsale.com')
        .send({ email: 'staff@chc.example', password: PASSWORD });
    const token = login.body.token;

    const echo = await request(app)
        .get('/api/admin/whoami-echo')
        .set('Host', 'chcsale.com')
        .set('Authorization', `Bearer ${token}`);
    assert.equal(echo.status, 200);
    assert.equal(echo.body.admin_id, CHC_ADMIN_ID);
});

test('a company token minted on one distributor is refused if replayed on another', async () => {
    reset();
    const chcCompanyToken = jwt.sign(
        { type: 'company', company_id: CHC_COMPANY_ID, slug: 'assured', company_name: 'Assured Collision', distributor_id: CHC_ID },
        process.env.JWT_SECRET, { expiresIn: '1h' }
    );
    const app = express();
    app.use(express.json());
    app.use(resolveDistributor);
    const { requireCompanyAuth } = require('../middleware/auth');
    app.get('/api/store/echo', requireCompanyAuth, (req, res) => res.json({ company_id: req.company.id }));

    process.env.PLATFORM_DOMAIN = 'platform.example';
    invalidateDistributorCache();
    try {
        const onAcme = await request(app).get('/api/store/echo').set('Host', 'acme.platform.example').set('Authorization', `Bearer ${chcCompanyToken}`);
        assert.equal(onAcme.status, 401);

        const onChc = await request(app).get('/api/store/echo').set('Host', 'chcsale.com').set('Authorization', `Bearer ${chcCompanyToken}`);
        assert.equal(onChc.status, 200);
    } finally {
        delete process.env.PLATFORM_DOMAIN;
        invalidateDistributorCache();
    }
});

test('a token issued before this feature shipped (no distributor_id claim) still works', async () => {
    reset();
    const legacyToken = jwt.sign(
        { type: 'company', company_id: CHC_COMPANY_ID, slug: 'assured', company_name: 'Assured Collision' }, // no distributor_id
        process.env.JWT_SECRET, { expiresIn: '1h' }
    );
    const app = express();
    app.use(express.json());
    app.use(resolveDistributor);
    const { requireCompanyAuth } = require('../middleware/auth');
    app.get('/api/store/echo', requireCompanyAuth, (req, res) => res.json({ company_id: req.company.id }));

    const res = await request(app).get('/api/store/echo').set('Host', 'chcsale.com').set('Authorization', `Bearer ${legacyToken}`);
    assert.equal(res.status, 200);
});

// ==================================================================
// routes/distributors-admin.js -- platform_admin only
// ==================================================================

function asAdmin(app, admin) { app.locals.testAdmin = admin; return app; }

test('a distributor super_admin (not platform_admin) is refused', async () => {
    reset();
    const app = asAdmin(platformApp(), { id: CHC_ADMIN_ID, role: 'super_admin', distributor_id: CHC_ID });
    const res = await request(app).get('/api/admin/platform/distributors').set('Host', 'chcsale.com');
    assert.equal(res.status, 403);
});

test('platform_admin can list distributors', async () => {
    reset();
    const app = asAdmin(platformApp(), { id: PLATFORM_ADMIN_ID, role: 'platform_admin', distributor_id: null });
    const res = await request(app).get('/api/admin/platform/distributors').set('Host', 'chcsale.com');
    assert.equal(res.status, 200);
    assert.equal(res.body.distributors.length, 2);
});

test('platform_admin can onboard a new distributor', async () => {
    reset();
    const app = asAdmin(platformApp(), { id: PLATFORM_ADMIN_ID, role: 'platform_admin', distributor_id: null });
    const res = await request(app)
        .post('/api/admin/platform/distributors')
        .set('Host', 'chcsale.com')
        .send({ name: 'Northwind Supply', contact_email: 'ops@northwind.example' });
    assert.equal(res.status, 201);
    assert.equal(res.body.distributor.slug, 'northwind-supply');
    assert.equal(res.body.distributor.is_default, false);
    assert.equal(res.body.distributor.is_active, true);
});

test('a duplicate distributor slug is rejected', async () => {
    reset();
    const app = asAdmin(platformApp(), { id: PLATFORM_ADMIN_ID, role: 'platform_admin', distributor_id: null });
    const res = await request(app)
        .post('/api/admin/platform/distributors')
        .set('Host', 'chcsale.com')
        .send({ name: 'Acme Again', slug: 'acme' });
    assert.equal(res.status, 409);
});

test('a duplicate custom domain is rejected', async () => {
    reset();
    const app = asAdmin(platformApp(), { id: PLATFORM_ADMIN_ID, role: 'platform_admin', distributor_id: null });
    const res = await request(app)
        .post('/api/admin/platform/distributors')
        .set('Host', 'chcsale.com')
        .send({ name: 'Copycat', custom_domain: 'https://chcsale.com/' });
    assert.equal(res.status, 409);
});

test('the default distributor cannot be deactivated', async () => {
    reset();
    const app = asAdmin(platformApp(), { id: PLATFORM_ADMIN_ID, role: 'platform_admin', distributor_id: null });
    const res = await request(app)
        .put(`/api/admin/platform/distributors/${CHC_ID}`)
        .set('Host', 'chcsale.com')
        .send({ is_active: false });
    assert.equal(res.status, 409);
});

test('a non-default distributor can be deactivated', async () => {
    reset();
    const app = asAdmin(platformApp(), { id: PLATFORM_ADMIN_ID, role: 'platform_admin', distributor_id: null });
    const res = await request(app)
        .put(`/api/admin/platform/distributors/${ACME_ID}`)
        .set('Host', 'chcsale.com')
        .send({ is_active: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.distributor.is_active, false);
});
