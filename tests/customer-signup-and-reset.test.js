/**
 * tests/customer-signup-and-reset.test.js
 *
 * The customer-user journey end to end, through the real routes: CHC (or an
 * owner) invites someone, they open the emailed link and set a password, sign
 * in, and later get a password-reset link. Covers the invite link's shape, the
 * password rules, one-time and expiring tokens, disabled accounts, the
 * "individual logins" module being off, and the set-password page keeping the
 * session the store needs.
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
    return `dddddddd-cccc-4ddd-8eee-${hex}`;
}

const fs = require('node:fs');
const bcrypt = require('bcrypt');

function asSuperAdmin() {
    authAdmin = { id: uid('super-admin'), email: 'adam@chcpaint.com', name: 'Adam', role: 'super_admin', is_active: true, must_change_password: false };
}

function seedCompany(label, settings) {
    const id = uid('co-' + label);
    fake.db.companies.push({
        id, name: label + ' Auto', slug: label.toLowerCase(), is_active: true,
        settings: settings === undefined ? { users: { enabled: true } } : settings,
        access_code: 'x', distributor_id: null
    });
    return { id, slug: label.toLowerCase(), name: label + ' Auto' };
}

const STRONG = 'Sturdy-Pass-9';

/** Invite through the admin route and return { co, email, token } from the email CHC would send. */
async function invite(co, email, extra) {
    asSuperAdmin();
    const resp = await request(app).post(`/api/admin/companies/${co.id}/users`).send({ name: 'Pat Customer', email, role: 'member', ...(extra || {}) });
    assert.equal(resp.status, 201, JSON.stringify(resp.body));
    const mail = sentInvites.at(-1);
    const url = new URL(mail.inviteUrl);
    return { resp, mail, url, token: url.searchParams.get('token') };
}

const accept = (token, password) => request(app).post('/api/auth/company-accept-invite').send({ token, password });
const login = (slug, email, password) => request(app).post('/api/auth/company-user-login').send({ slug, email, password });

// ---- sign-up (invite) ------------------------------------------------

test('an invite emails a one-time link to the set-password page for the right company', async () => {
    const co = seedCompany('Link');
    const { resp, mail, url, token } = await invite(co, 'pat@link.example');
    assert.equal(resp.body.email_sent, true);
    assert.equal(mail.to, 'pat@link.example');
    assert.equal(url.origin + url.pathname, 'https://chcsale.com/set-password.html');
    assert.equal(url.searchParams.get('kind'), 'company');
    assert.equal(url.searchParams.get('slug'), co.slug);
    assert.match(token, /^[0-9a-f]{64}$/);
    const row = fake.db.company_users.find(u => u.email === 'pat@link.example');
    assert.equal(row.password_hash, null, 'cannot sign in before accepting');
    assert.ok(new Date(row.invite_expires_at) > new Date(Date.now() + 6 * 86400000), 'expires in about 7 days');
});

test('the admin is told when the invite email could not be sent', async () => {
    const co = seedCompany('Nomail');
    inviteOutcome = { sent: false, error: 'sender not verified' };
    try {
        asSuperAdmin();
        const resp = await request(app).post(`/api/admin/companies/${co.id}/users`).send({ name: 'No Mail', email: 'nomail@example.com' });
        assert.equal(resp.status, 201);
        assert.equal(resp.body.email_sent, false);
    } finally { inviteOutcome = { sent: true }; }
});

test('accepting the invite sets the password, signs them in, and the link works once only', async () => {
    const co = seedCompany('Accept');
    const { token } = await invite(co, 'ann@accept.example');

    const ok = await accept(token, STRONG);
    assert.equal(ok.status, 200);
    assert.ok(ok.body.token);
    assert.equal(ok.body.user.email, 'ann@accept.example');
    assert.equal(ok.body.company.slug, co.slug);

    const row = fake.db.company_users.find(u => u.email === 'ann@accept.example');
    assert.ok(row.password_hash && row.password_hash !== STRONG);
    assert.equal(await bcrypt.compare(STRONG, row.password_hash), true);
    assert.equal(row.invite_token, null);

    const again = await accept(token, 'Another-Pass-1');
    assert.equal(again.status, 400);
    assert.match(again.body.error, /invalid or has already been used/i);
});

test('weak passwords are refused and do not burn the invite', async () => {
    const co = seedCompany('Weak');
    const { token } = await invite(co, 'wes@weak.example');
    for (const pw of ['short1A', 'alllowercase1', 'ALLUPPERCASE1', 'NoNumbersHere', '', undefined]) {
        const resp = await accept(token, pw);
        assert.equal(resp.status, 400, `password ${JSON.stringify(pw)}`);
    }
    assert.equal((await accept(token, STRONG)).status, 200, 'the same link still works afterwards');
});

test('an unknown or missing token is refused', async () => {
    assert.equal((await accept('f'.repeat(64), STRONG)).status, 400);
    assert.equal((await accept('', STRONG)).status, 400);
});

test('an expired invite is refused with a clear message', async () => {
    const co = seedCompany('Expired');
    const { token } = await invite(co, 'exp@expired.example');
    fake.db.company_users.find(u => u.email === 'exp@expired.example').invite_expires_at = new Date(Date.now() - 1000).toISOString();
    const resp = await accept(token, STRONG);
    assert.equal(resp.status, 400);
    assert.match(resp.body.error, /expired/i);
});

test('a deactivated user cannot activate from an old invite', async () => {
    const co = seedCompany('Off');
    const { token } = await invite(co, 'off@off.example');
    fake.db.company_users.find(u => u.email === 'off@off.example').is_active = false;
    assert.equal((await accept(token, STRONG)).status, 403);
});

// ---- signing in ------------------------------------------------------

test('after accepting, the user can sign in with email and password (email case does not matter)', async () => {
    const co = seedCompany('Signin');
    const { token } = await invite(co, 'sam@signin.example');
    await accept(token, STRONG);

    const ok = await login(co.slug, 'SAM@Signin.Example', STRONG);
    assert.equal(ok.status, 200);
    assert.ok(ok.body.token);
    assert.equal(ok.body.user.name, 'Pat Customer');

    assert.equal((await login(co.slug, 'sam@signin.example', 'Wrong-Pass-1')).status, 401);
});

test('an invited user who has not set a password cannot sign in', async () => {
    const co = seedCompany('Early');
    await invite(co, 'eve@early.example');
    assert.equal((await login(co.slug, 'eve@early.example', STRONG)).status, 401);
});

test('a user cannot sign in to a different company\'s store', async () => {
    const a = seedCompany('Alpha'), b = seedCompany('Bravo');
    const { token } = await invite(a, 'al@alpha.example');
    await accept(token, STRONG);
    assert.equal((await login(b.slug, 'al@alpha.example', STRONG)).status, 401);
});

test('when the company has individual logins switched off, the sign-in is refused (the invite itself still works)', async () => {
    const co = seedCompany('Modoff', { users: { enabled: false } });
    const { token } = await invite(co, 'mo@modoff.example');
    assert.equal((await accept(token, STRONG)).status, 200);
    const resp = await login(co.slug, 'mo@modoff.example', STRONG);
    assert.equal(resp.status, 403);
    assert.match(resp.body.error, /not enabled/i);
});

// ---- password reset (resend) -----------------------------------------

test('reset: a new link is emailed; the old password keeps working until the new one is set; then only the new one works', async () => {
    const co = seedCompany('Reset');
    const first = await invite(co, 'rita@reset.example');
    await accept(first.token, STRONG);
    const user = fake.db.company_users.find(u => u.email === 'rita@reset.example');

    asSuperAdmin();
    const resend = await request(app).post(`/api/admin/companies/${co.id}/users/${user.id}/resend-invite`);
    assert.equal(resend.status, 200);
    assert.equal(resend.body.email_sent, true);
    const url = new URL(sentInvites.at(-1).inviteUrl);
    const resetToken = url.searchParams.get('token');
    assert.notEqual(resetToken, first.token);
    assert.equal(url.searchParams.get('slug'), co.slug);

    assert.equal((await login(co.slug, 'rita@reset.example', STRONG)).status, 200, 'old password still valid before the reset is used');

    const NEW = 'Brand-New-Pass-7';
    assert.equal((await accept(resetToken, NEW)).status, 200);
    assert.equal((await login(co.slug, 'rita@reset.example', STRONG)).status, 401, 'old password is dead');
    assert.equal((await login(co.slug, 'rita@reset.example', NEW)).status, 200);

    assert.equal((await accept(resetToken, 'Third-Pass-3')).status, 400, 'a reset link works once');
});

test('reset: asking twice makes the earlier link stop working', async () => {
    const co = seedCompany('Twice');
    const first = await invite(co, 'tina@twice.example');
    const user = fake.db.company_users.find(u => u.email === 'tina@twice.example');
    asSuperAdmin();
    await request(app).post(`/api/admin/companies/${co.id}/users/${user.id}/resend-invite`);
    const second = new URL(sentInvites.at(-1).inviteUrl).searchParams.get('token');
    assert.equal((await accept(first.token, STRONG)).status, 400, 'the first link is superseded');
    assert.equal((await accept(second, STRONG)).status, 200);
});

test('reset is scoped: another company cannot trigger a reset for this company\'s user', async () => {
    const a = seedCompany('Scopea'), b = seedCompany('Scopeb');
    await invite(a, 'sc@scopea.example');
    const user = fake.db.company_users.find(u => u.email === 'sc@scopea.example');
    asSuperAdmin();
    const resp = await request(app).post(`/api/admin/companies/${b.id}/users/${user.id}/resend-invite`);
    assert.equal(resp.status, 404);
});

// ---- the set-password page ---------------------------------------------

test('the set-password page keeps the signed-in USER for company invites, not just the token', () => {
    // The store restores state.companyUser from sessionStorage 'chc_user' (see
    // public/store.html). Without it an invited customer lands signed in but
    // the store does not know who they are or whether they are an owner.
    const html = fs.readFileSync(path.join(ROOT, 'public/set-password.html'), 'utf8');
    const companyBranch = html.slice(html.indexOf("sessionStorage.setItem('chc_token'"));
    assert.match(companyBranch, /sessionStorage\.setItem\('chc_user'/);
});

test('the set-password page sends company invites to the company endpoint and the store', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public/set-password.html'), 'utf8');
    assert.match(html, /company-accept-invite/);
    assert.match(html, /'\/store\/' \+ /);
});

// ---- self-service "Forgot password?" ------------------------------------

const forgot = (slug, email) => request(app).post('/api/auth/company-user-forgot').send({ slug, email });
const mailCount = () => sentInvites.length;
/** Pretend the last emailed link was issued `minutes` ago. */
function ageLink(email, minutes) {
    const u = fake.db.company_users.find(x => x.email === email);
    u.invite_expires_at = new Date(Date.now() + 7 * 86400000 - minutes * 60000).toISOString();
}

async function activeUser(label, email) {
    const co = seedCompany(label);
    const { token } = await invite(co, email);
    await accept(token, STRONG);
    return co;
}

test('forgot password: an active user is emailed a reset link that really resets the password', async () => {
    const co = await activeUser('Fgot', 'fay@fgot.example');
    const before = mailCount();

    const resp = await forgot(co.slug, 'FAY@fgot.example');
    assert.equal(resp.status, 200);
    assert.match(resp.body.message, /on its way/);
    assert.equal(mailCount(), before + 1);
    const mail = sentInvites.at(-1);
    assert.equal(mail.to, 'fay@fgot.example');
    assert.equal(mail.reset, true, 'worded as a reset, not a first invitation');

    const token = new URL(mail.inviteUrl).searchParams.get('token');
    const NEW = 'Forgot-It-All-4';
    assert.equal((await accept(token, NEW)).status, 200);
    assert.equal((await login(co.slug, 'fay@fgot.example', STRONG)).status, 401);
    assert.equal((await login(co.slug, 'fay@fgot.example', NEW)).status, 200);
});

test('forgot password: the answer is identical whether or not the address has an account', async () => {
    const co = await activeUser('Same', 'real@same.example');
    const before = mailCount();
    const known = await forgot(co.slug, 'real@same.example');
    const unknown = await forgot(co.slug, 'nobody@same.example');
    const noCompany = await forgot('no-such-company', 'real@same.example');
    assert.equal(known.status, 200); assert.equal(unknown.status, 200); assert.equal(noCompany.status, 200);
    assert.deepEqual(unknown.body, known.body);
    assert.deepEqual(noCompany.body, known.body);
    assert.equal(mailCount(), before + 1, 'only the real address produced an email');
});

test('forgot password: asking again straight away does not send another email', async () => {
    const co = await activeUser('Cool', 'cal@cool.example');
    await forgot(co.slug, 'cal@cool.example');
    const after = mailCount();
    const again = await forgot(co.slug, 'cal@cool.example');
    assert.equal(again.status, 200);
    assert.equal(mailCount(), after, 'cooldown');

    ageLink('cal@cool.example', 11);
    await forgot(co.slug, 'cal@cool.example');
    assert.equal(mailCount(), after + 1, 'allowed again after the cooldown');
});

test('forgot password: a newer link supersedes the older one', async () => {
    const co = await activeUser('Newer', 'nel@newer.example');
    await forgot(co.slug, 'nel@newer.example');
    const first = new URL(sentInvites.at(-1).inviteUrl).searchParams.get('token');
    ageLink('nel@newer.example', 11);
    await forgot(co.slug, 'nel@newer.example');
    const second = new URL(sentInvites.at(-1).inviteUrl).searchParams.get('token');
    assert.notEqual(first, second);
    assert.equal((await accept(first, STRONG)).status, 400);
    assert.equal((await accept(second, STRONG)).status, 200);
});

test('forgot password: someone who never finished their invite gets a fresh invite-style email', async () => {
    const co = seedCompany('Lost');
    await invite(co, 'lou@lost.example');
    ageLink('lou@lost.example', 30);
    const before = mailCount();
    await forgot(co.slug, 'lou@lost.example');
    assert.equal(mailCount(), before + 1);
    assert.equal(sentInvites.at(-1).reset, false);
});

test('forgot password: no email for a deactivated user or when individual logins are off', async () => {
    const co = await activeUser('Dead', 'dee@dead.example');
    fake.db.company_users.find(u => u.email === 'dee@dead.example').is_active = false;
    const off = seedCompany('Gone', { users: { enabled: false } });
    await invite(off, 'gus@gone.example');
    ageLink('gus@gone.example', 30);

    const before = mailCount();
    assert.equal((await forgot(co.slug, 'dee@dead.example')).status, 200);
    assert.equal((await forgot(off.slug, 'gus@gone.example')).status, 200);
    assert.equal(mailCount(), before);
});

test('forgot password: a missing email is a plain 400; a failing email service does not leak', async () => {
    const co = await activeUser('Fail', 'fil@fail.example');
    assert.equal((await request(app).post('/api/auth/company-user-forgot').send({ slug: co.slug })).status, 400);

    inviteOutcome = { sent: false, error: 'sender not verified' };
    try {
        const resp = await forgot(co.slug, 'fil@fail.example');
        assert.equal(resp.status, 200);
        assert.match(resp.body.message, /on its way/);
    } finally { inviteOutcome = { sent: true }; }
});

test('forgot password: a user cannot trigger a reset for another company\'s account', async () => {
    const a = await activeUser('Ownera', 'x@ownera.example');
    const b = seedCompany('Ownerb');
    const before = mailCount();
    await forgot(b.slug, 'x@ownera.example');
    assert.equal(mailCount(), before);
});

test('reset links from the admin button are worded as a reset only for users who already have a password', async () => {
    const co = await activeUser('Wording', 'wen@wording.example');
    const user = fake.db.company_users.find(u => u.email === 'wen@wording.example');
    asSuperAdmin();
    const resp = await request(app).post(`/api/admin/companies/${co.id}/users/${user.id}/resend-invite`);
    assert.match(resp.body.message, /Password-reset link sent/);
    assert.equal(sentInvites.at(-1).reset, true);

    const fresh = await invite(co, 'nia@wording.example');
    const nia = fake.db.company_users.find(u => u.email === 'nia@wording.example');
    const r2 = await request(app).post(`/api/admin/companies/${co.id}/users/${nia.id}/resend-invite`);
    assert.match(r2.body.message, /Invite sent/);
    assert.equal(sentInvites.at(-1).reset, false);
});

test('the store sign-in has a Forgot password link wired to the endpoint', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public/store.html'), 'utf8');
    assert.match(html, /id="forgot-password-link"/);
    assert.match(html, /company-user-forgot/);
});
