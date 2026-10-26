/**
 * tests/admin-forgot-password.test.js
 *
 * CHC staff recovering their own console account: "Forgot password?" on the
 * sign-in, the emailed link, choosing a new password, and the no-email fallback
 * (an admin makes a link and hands it over) for people whose inbox is not
 * receiving mail.
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
let inviteOutcome = { sent: true };

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
        sendInvite: async (o) => { sentInvites.push(o); return inviteOutcome; },
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
const authRoutes = require('../routes/auth');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);
app.use('/api/auth', authRoutes);

function uid(label) {
    const hex = require('node:crypto').createHash('sha1').update(label).digest('hex').slice(0, 12);
    return `eeeeeeee-cccc-4ddd-8eee-${hex}`;
}
const bcrypt = require('bcrypt');
const STRONG = 'Sturdy-Pass-9';

function asSuperAdmin() {
    authAdmin = { id: uid('super-admin'), email: 'adam@chcpaint.com', name: 'Adam', role: 'super_admin', is_active: true, must_change_password: false };
}

async function seedStaff(label, extra = {}) {
    const id = uid('staff-' + label);
    fake.db.admin_users = (fake.db.admin_users || []).filter(a => a.id !== id);
    fake.db.admin_users.push({
        id, email: `${label}@chcpaint.com`, name: label, role: 'order_desk', is_active: true,
        password_hash: await bcrypt.hash('Old-Password-1', 4), must_change_password: false,
        company_id: null, branch_id: null, distributor_id: null,
        invite_token: null, invite_expires_at: null, updated_at: '2020-01-01T00:00:00.000Z', ...extra
    });
    return id;
}
const row = id => fake.db.admin_users.find(a => a.id === id);
const forgot = email => request(app).post('/api/auth/admin-forgot').send({ email });
const accept = (token, password) => request(app).post('/api/auth/admin-accept-invite').send({ token, password });
const signIn = (email, password) => request(app).post('/api/auth/admin-login').send({ email, password });
const tokenOf = mail => new URL(mail.inviteUrl).searchParams.get('token');

function fresh() {
    sentInvites.length = 0;
    inviteOutcome = { sent: true };
    fake.db.admin_users = [];
}

test('forgot password emails a one-time link to the set-password page, valid for a day', async () => {
    fresh(); const id = await seedStaff('frankg');
    const res = await forgot('frankg@chcpaint.com');
    assert.equal(res.status, 200);
    assert.equal(sentInvites.length, 1);
    const mail = sentInvites[0];
    assert.equal(mail.to, 'frankg@chcpaint.com');
    assert.equal(mail.reset, true, 'someone with a password gets reset wording, not "you have been invited"');
    const url = new URL(mail.inviteUrl);
    assert.equal(url.pathname, '/set-password.html');
    assert.equal(url.searchParams.get('kind'), 'admin');
    const hours = (new Date(row(id).invite_expires_at) - Date.now()) / 36e5;
    assert.ok(hours > 23 && hours <= 24.01, `expected about 24h, got ${hours}`);
});

test('the whole journey: forgot, open the link, choose a password, sign in with it', async () => {
    fresh(); await seedStaff('frankg', { must_change_password: true });
    await forgot('frankg@chcpaint.com');
    const token = tokenOf(sentInvites[0]);

    const weak = await accept(token, 'password');
    assert.equal(weak.status, 400);

    const ok = await accept(token, STRONG);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.token, 'the page signs them straight in');

    const old = await signIn('frankg@chcpaint.com', 'Old-Password-1');
    assert.equal(old.status, 401, 'the old password stops working');
    const now = await signIn('frankg@chcpaint.com', STRONG);
    assert.equal(now.status, 200);
    assert.equal(now.body.must_change_password, false, 'choosing your own password clears the forced-change flag');

    const again = await accept(token, 'Another-Pass-9');
    assert.equal(again.status, 400, 'a link works once');
});

test('the answer is identical whether or not the address has an account', async () => {
    fresh(); await seedStaff('frankg');
    const real = await forgot('frankg@chcpaint.com');
    const fake_ = await forgot('nobody@chcpaint.com');
    assert.equal(real.status, fake_.status);
    assert.deepEqual(real.body, fake_.body);
    assert.equal(sentInvites.length, 1, 'only the real account is emailed');
});

test('capital letters in the typed address do not matter', async () => {
    fresh(); await seedStaff('frankg');
    await forgot('  FrankG@CHCPaint.com ');
    assert.equal(sentInvites.length, 1);
});

test('a disabled account gets nothing', async () => {
    fresh(); await seedStaff('gone', { is_active: false });
    const res = await forgot('gone@chcpaint.com');
    assert.equal(res.status, 200);
    assert.equal(sentInvites.length, 0);
});

test('asking twice in a row sends one email, not two', async () => {
    fresh(); await seedStaff('frankg');
    await forgot('frankg@chcpaint.com');
    await forgot('frankg@chcpaint.com');
    assert.equal(sentInvites.length, 1);
});

test('someone who never finished their invite can use forgot password to get going', async () => {
    fresh(); await seedStaff('newbie', { password_hash: null });
    await forgot('newbie@chcpaint.com');
    assert.equal(sentInvites.length, 1);
    assert.equal(sentInvites[0].reset, false, 'no password yet, so it reads as an invitation');
    const ok = await accept(tokenOf(sentInvites[0]), STRONG);
    assert.equal(ok.status, 200);
});

test('staff of another distributor are not emailed from this one', async () => {
    fresh(); await seedStaff('other', { distributor_id: 'dddddddd-0000-4000-8000-000000000001' });
    const a2 = express(); a2.use(express.json());
    a2.use((req, _res, next) => { req.distributor = { id: 'dddddddd-0000-4000-8000-000000000002' }; next(); });
    a2.use('/api/auth', authRoutes);
    const res = await request(a2).post('/api/auth/admin-forgot').send({ email: 'other@chcpaint.com' });
    assert.equal(res.status, 200);
    assert.equal(sentInvites.length, 0);
});

test('a missing email address is a clear error, a failed send is not', async () => {
    fresh(); await seedStaff('frankg');
    const none = await request(app).post('/api/auth/admin-forgot').send({});
    assert.equal(none.status, 400);
    assert.match(none.body.error, /email/i);

    inviteOutcome = { sent: false, error: 'The from address does not match a verified Sender Identity' };
    const res = await forgot('frankg@chcpaint.com');
    assert.equal(res.status, 200, 'the requester is told nothing about a delivery failure');
});

// ---- the no-email fallback ----------------------------------------------

test('an admin can make a reset link for staff without sending any email', async () => {
    fresh(); asSuperAdmin(); const id = await seedStaff('frankg');
    const res = await request(app).post(`/api/admin/users/${id}/resend-invite`).send({ link_only: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(sentInvites.length, 0, 'nothing is emailed');
    assert.equal(res.body.email_sent, false);
    const token = new URL(res.body.link).searchParams.get('token');
    assert.equal(new URL(res.body.link).searchParams.get('kind'), 'admin');
    const ok = await accept(token, STRONG);
    assert.equal(ok.status, 200);
    assert.equal((await signIn('frankg@chcpaint.com', STRONG)).status, 200);
});

test('when the email cannot be sent the admin is handed the link and the reason', async () => {
    fresh(); asSuperAdmin(); const id = await seedStaff('frankg');
    inviteOutcome = { sent: false, error: 'blocked by recipient server' };
    const res = await request(app).post(`/api/admin/users/${id}/resend-invite`).send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.email_sent, false);
    assert.match(res.body.link, /set-password\.html\?token=/);
    assert.equal(res.body.email_error, 'blocked by recipient server');
});

test('a link that was emailed successfully is not also returned', async () => {
    fresh(); asSuperAdmin(); const id = await seedStaff('frankg');
    const res = await request(app).post(`/api/admin/users/${id}/resend-invite`).send({});
    assert.equal(res.body.email_sent, true);
    assert.equal(res.body.link, undefined);
});

test('the same fallback works for a customer user', async () => {
    fresh(); asSuperAdmin();
    const co = { id: uid('co'), name: 'Pat Auto', slug: 'pat', is_active: true, settings: { users: { enabled: true } }, access_code: 'x', distributor_id: null };
    fake.db.companies.push(co);
    fake.db.company_users = fake.db.company_users || [];
    const user = { id: uid('cu'), company_id: co.id, email: 'pat@example.com', name: 'Pat', role: 'member', is_active: true, password_hash: 'h', invite_token: null, invite_expires_at: null };
    fake.db.company_users.push(user);
    const res = await request(app).post(`/api/admin/companies/${co.id}/users/${user.id}/resend-invite`).send({ link_only: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(sentInvites.length, 0);
    assert.equal(new URL(res.body.link).searchParams.get('kind'), 'company');
    assert.equal(new URL(res.body.link).searchParams.get('slug'), 'pat');
});
