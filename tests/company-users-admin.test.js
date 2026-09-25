/**
 * tests/company-users-admin.test.js
 *
 * CHC's seeding of a company's customer users (utils/company-users.js,
 * mounted at /api/admin/companies/:companyId/users by
 * routes/company-users-admin.js). No test file covered this route before —
 * this one grounds the pre-existing create/list/deactivate behaviour and
 * adds coverage for the two admin-panel additions: editing a user's
 * name/email, and permanently deleting one.
 *
 * Harness copied from tests/staff-access.test.js.
 *
 *   node --test tests/
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

// ----------------------------------------------------------------------
// Baseline: create / list / deactivate (previously untested)
// ----------------------------------------------------------------------

test('POST creates a customer user and sends an invite', async () => {
    asSuperAdmin();
    const co = uid('co-baseline');
    seedCompany(co, 'Baseline Co');

    const resp = await request(app).post(`/api/admin/companies/${co}/users`).send({
        name: 'Pat Customer', email: 'pat@example.com', role: 'member'
    });
    assert.equal(resp.status, 201);
    assert.equal(resp.body.user.email, 'pat@example.com');
    assert.equal(sentInvites.at(-1).to, 'pat@example.com');
});

test('DELETE (no /purge) deactivates rather than removing the row', async () => {
    asSuperAdmin();
    const co = uid('co-deactivate');
    const u = uid('user-deactivate');
    seedCompany(co, 'Deactivate Co');
    seedCompanyUser(u, co, {});

    const resp = await request(app).delete(`/api/admin/companies/${co}/users/${u}`);
    assert.equal(resp.status, 200);
    const stored = fake.db.company_users.find(x => x.id === u);
    assert.ok(stored, 'the row is still there');
    assert.equal(stored.is_active, false);
});

// ----------------------------------------------------------------------
// New: editing name/email
// ----------------------------------------------------------------------

test('PUT edits name and email', async () => {
    asSuperAdmin();
    const co = uid('co-edit');
    const u = uid('user-edit');
    seedCompany(co, 'Edit Co');
    seedCompanyUser(u, co, { name: 'Old Name', email: 'old@example.com' });

    const resp = await request(app).put(`/api/admin/companies/${co}/users/${u}`).send({
        name: 'New Name', email: 'new@example.com'
    });
    assert.equal(resp.status, 200);
    assert.equal(resp.body.user.name, 'New Name');
    assert.equal(resp.body.user.email, 'new@example.com');
    assert.equal(fake.db.company_users.find(x => x.id === u).email, 'new@example.com');
});

test('PUT refuses an email already used by another user in the same company', async () => {
    asSuperAdmin();
    const co = uid('co-dupe');
    const u1 = uid('user-dupe-1'), u2 = uid('user-dupe-2');
    seedCompany(co, 'Dupe Co');
    seedCompanyUser(u1, co, { email: 'taken@example.com' });
    seedCompanyUser(u2, co, { email: 'free@example.com' });

    const resp = await request(app).put(`/api/admin/companies/${co}/users/${u2}`).send({ email: 'taken@example.com' });
    assert.equal(resp.status, 409);
    assert.equal(fake.db.company_users.find(x => x.id === u2).email, 'free@example.com');
});

test('PUT refuses a malformed email', async () => {
    asSuperAdmin();
    const co = uid('co-bad-email');
    const u = uid('user-bad-email');
    seedCompany(co, 'Bad Email Co');
    seedCompanyUser(u, co, { email: 'ok@example.com' });

    const resp = await request(app).put(`/api/admin/companies/${co}/users/${u}`).send({ email: 'not-an-email' });
    assert.equal(resp.status, 400);
});

test('the same email is allowed to reuse itself unchanged (does not collide with its own row)', async () => {
    asSuperAdmin();
    const co = uid('co-self-email');
    const u = uid('user-self-email');
    seedCompany(co, 'Self Email Co');
    seedCompanyUser(u, co, { name: 'Same Email', email: 'same@example.com' });

    const resp = await request(app).put(`/api/admin/companies/${co}/users/${u}`).send({
        name: 'Same Email Updated', email: 'same@example.com'
    });
    assert.equal(resp.status, 200);
});

// ----------------------------------------------------------------------
// New: permanent delete
// ----------------------------------------------------------------------

test('DELETE /:id/purge refuses on a still-active account', async () => {
    asSuperAdmin();
    const co = uid('co-purge-active');
    const u = uid('user-purge-active');
    seedCompany(co, 'Purge Active Co');
    seedCompanyUser(u, co, { is_active: true });

    const resp = await request(app).delete(`/api/admin/companies/${co}/users/${u}/purge`);
    assert.equal(resp.status, 400);
    assert.ok(fake.db.company_users.find(x => x.id === u), 'row must still exist');
});

test('DELETE /:id/purge removes the row once deactivated', async () => {
    asSuperAdmin();
    const co = uid('co-purge-ok');
    const u = uid('user-purge-ok');
    seedCompany(co, 'Purge Ok Co');
    seedCompanyUser(u, co, { is_active: false });

    const resp = await request(app).delete(`/api/admin/companies/${co}/users/${u}/purge`);
    assert.equal(resp.status, 200);
    assert.equal(fake.db.company_users.find(x => x.id === u), undefined);
});

test('DELETE /:id/purge is scoped to the company -- cannot purge another company\'s user', async () => {
    asSuperAdmin();
    const coA = uid('co-purge-scope-a'), coB = uid('co-purge-scope-b');
    const u = uid('user-purge-scope');
    seedCompany(coA, 'Scope A'); seedCompany(coB, 'Scope B');
    seedCompanyUser(u, coA, { is_active: false });

    const resp = await request(app).delete(`/api/admin/companies/${coB}/users/${u}/purge`);
    assert.equal(resp.status, 404);
    assert.ok(fake.db.company_users.find(x => x.id === u), 'row must still exist under its real company');
});
