/**
 * tests/people-activity.test.js
 *
 * "People & activity" -- the North Seven / York Mills request: know who orders
 * and who signs in, tie every order to a named person, and organise people into
 * named groups so overspending can be spotted and addressed.
 *
 * Covers the pure report maths (utils/people-activity.js summarise), the groups
 * endpoints, the sign-in log, ordering as an individual (the person is taken
 * from the database, never the form; a deactivated person is stopped at once),
 * the shared-code lock-out once the module is on, who may read and who may
 * change what, hide-pricing, and the guarantees that make it safe to ship
 * before the migration has been applied.
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
let fake = createFakeSupabase();

const supabaseProxy = new Proxy({}, {
    get: (_t, prop) => {
        const v = fake[prop];
        return typeof v === 'function' ? v.bind(fake) : v;
    }
});

let authAdmin = null;
const sentOrders = [];

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
        sendInvite: async () => ({ sent: true }),
        sendOrderNotification: async o => { sentOrders.push(o); return { sent: true }; },
        sendOrderStatusUpdate: async () => ({ sent: true }),
        sendOrderNoteAdded: async () => ({ sent: true }),
        sendContactNote: async () => ({ sent: true }),
        sendInvoiceReady: async () => ({ sent: true }),
        sendOrderClosed: async () => ({ sent: true }),
        sendLowStockAlert: async () => ({ sent: true }),
        sendReorderRaised: async () => ({ sent: true })
    },
    [path.join(ROOT, 'utils/recipients.js')]: {
        resolveOrderRecipients: async () => ({ to: ['branch@example.invalid'], replyTo: null, staffTo: [], customerTo: [] }),
        validEmails: l => l
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

// Real company-token checks (so owner / member behaviour is the real thing);
// only the staff-token lookup is replaced.
const realAuth = require('../middleware/auth');
stubs[path.join(ROOT, 'middleware/auth.js')] = {
    ...realAuth,
    requireAdminAuth: (req, res, next) => {
        if (!authAdmin) return res.status(401).json({ error: 'Admin access denied.' });
        req.admin = authAdmin;
        next();
    }
};

const express = require('express');
const request = require('supertest');
const bcrypt = require('bcrypt');
const adminRoutes = require('../routes/admin');
const authRoutes = require('../routes/auth');
const storefront = require('../routes/storefront');
const pa = require('../utils/people-activity');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use('/api/admin', adminRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/store', storefront);

const id = (n, c) => `${c || 'c'}${String(n).padStart(7, '0')}-1111-4111-8111-111111111111`.slice(0, 36);
const CO = id(1, '1'), CO2 = id(2, '2');
const LOC = id(3, '3'), LOC2 = id(4, '4');
const PRODUCT = id(5, '5');
const PW = 'Sturdy-Pass-9';
const HASH = bcrypt.hashSync(PW, 4);

const asSuper = () => { authAdmin = { id: id(90, '9'), role: 'super_admin', is_active: true, must_change_password: false }; };
const asAdminOf = co => { authAdmin = { id: id(91, '9'), role: 'admin', company_id: co, is_active: true, must_change_password: false }; };
const asManager = () => { authAdmin = { id: id(92, '9'), role: 'order_manager', is_active: true, must_change_password: false }; };
const asDesk = () => { authAdmin = { id: id(93, '9'), role: 'order_desk', is_active: true, must_change_password: false }; };

function seed({ activity = true, hidePricing = false } = {}) {
    const settings = { users: { enabled: true, owner_can_invite: true, require_individual_login: true } };
    if (activity) settings.activity = { enabled: true };
    if (hidePricing) settings.hide_pricing = { enabled: true };
    fake = createFakeSupabase({
        companies: [
            { id: CO, name: 'North Seven', slug: 'northseven', is_active: true, access_code: bcrypt.hashSync('shared', 4), settings, contact_email: 'shop@example.invalid', email_config: {}, distributor_id: null },
            { id: CO2, name: 'Other Shop', slug: 'other', is_active: true, access_code: 'x', settings: { users: { enabled: true }, activity: { enabled: true } }, distributor_id: null }
        ],
        company_locations: [
            { id: LOC, company_id: CO, name: 'North Seven', is_active: true, restrict_to_category: null },
            { id: LOC2, company_id: CO, name: 'York Mills', is_active: true, restrict_to_category: null }
        ],
        products: [{ id: PRODUCT, company_id: CO, sku: 'X-1', name: 'Widget', category: 'Misc', price: 10, is_active: true, price_on_request: false }],
        company_users: [
            { id: id(11, 'a'), company_id: CO, email: 'owner@ns.test', name: 'Louie Owner', role: 'owner', is_active: true, password_hash: HASH, location_id: null, group_id: null },
            { id: id(12, 'a'), company_id: CO, email: 'pat@ns.test', name: 'Pat Painter', role: 'member', is_active: true, password_hash: HASH, location_id: LOC, group_id: null },
            { id: id(13, 'a'), company_id: CO, email: 'sam@ns.test', name: 'Sam Estimator', role: 'member', is_active: true, password_hash: HASH, location_id: LOC2, group_id: null },
            { id: id(14, 'a'), company_id: CO, email: 'new@ns.test', name: 'Nia Newhire', role: 'member', is_active: true, password_hash: null, location_id: null, group_id: null },
            { id: id(15, 'a'), company_id: CO2, email: 'x@other.test', name: 'Outsider', role: 'member', is_active: true, password_hash: HASH, location_id: null, group_id: null }
        ],
        company_user_groups: [], company_user_logins: [], orders: [], audit_log: [], company_po_sequences: []
    });
    sentOrders.length = 0;
}

const U = { owner: id(11, 'a'), pat: id(12, 'a'), sam: id(13, 'a'), nia: id(14, 'a'), outsider: id(15, 'a') };

const signIn = async (email, slug = 'northseven', password = PW) =>
    request(app).post('/api/auth/company-user-login').send({ slug, email, password });
async function tokenFor(email) {
    const r = await signIn(email);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.token;
}
const order = (token, over) => request(app).post('/api/store/northseven/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({
        contact_name: 'Whoever', contact_email: 'whoever@x.test', contact_phone: '1',
        location_id: LOC, location: 'North Seven', po_number: 'PO-1',
        items: [{ product_id: PRODUCT, quantity: 2 }], ...(over || {})
    });

// =========================================================================
// The report maths (pure)
// =========================================================================

const mkUser = (n, name, extra) => ({ id: `u${n}`, name, email: `${name}@x.test`, role: 'member', is_active: true, password_hash: 'h', group_name: null, location_name: null, ...(extra || {}) });
const mkOrder = (n, user, total, extra) => ({ id: `o${n}`, created_at: `2026-10-0${n}T12:00:00Z`, status: 'pending', total, items: [{ quantity: 2 }], placed_by_user_id: user, ...(extra || {}) });

test('summarise: per-person orders, units, spend, average, largest, share and last order', () => {
    const r = pa.summarise({
        users: [mkUser(1, 'Pat', { group_name: 'Painters' }), mkUser(2, 'Sam', { group_name: 'Estimators' })],
        orders: [mkOrder(1, 'u1', 100), mkOrder(2, 'u1', 300), mkOrder(3, 'u2', 100)]
    });
    const pat = r.people.find(p => p.name === 'Pat');
    assert.equal(pat.orders, 2);
    assert.equal(pat.units, 4);
    assert.equal(pat.spend, 400);
    assert.equal(pat.avg_order, 200);
    assert.equal(pat.largest_order, 300);
    assert.equal(pat.share, 80);
    assert.equal(pat.last_order_at, '2026-10-02T12:00:00Z');
    assert.equal(r.summary.orders, 3);
    assert.equal(r.summary.spend, 500);
    assert.equal(r.people[0].name, 'Pat', 'biggest spender listed first');
    assert.deepEqual(r.groups.map(g => [g.name, g.spend]), [['Painters', 400], ['Estimators', 100]]);
});

test('summarise: cancelled orders are counted separately and never added to spend', () => {
    const r = pa.summarise({
        users: [mkUser(1, 'Pat')],
        orders: [mkOrder(1, 'u1', 100), mkOrder(2, 'u1', 900, { status: 'cancelled' })]
    });
    assert.equal(r.people[0].spend, 100);
    assert.equal(r.summary.cancelled_orders, 1);
    assert.equal(r.summary.spend, 100);
});

test('summarise: people who did not order still appear, with zeros', () => {
    const r = pa.summarise({ users: [mkUser(1, 'Pat'), mkUser(2, 'Idle')], orders: [mkOrder(1, 'u1', 50)] });
    const idle = r.people.find(p => p.name === 'Idle');
    assert.equal(idle.orders, 0);
    assert.equal(idle.spend, 0);
    assert.equal(idle.avg_order, 0);
    assert.equal(r.summary.people_ordering, 1);
});

test('summarise: a shared-code order is shown as unattributed, not hidden or guessed', () => {
    const r = pa.summarise({ users: [mkUser(1, 'Pat')], orders: [mkOrder(1, 'u1', 100), mkOrder(2, null, 250)] });
    assert.equal(r.summary.shared_login_orders, 1);
    assert.equal(r.summary.shared_login_spend, 250);
    assert.equal(r.summary.orders, 2);
    assert.equal(r.summary.spend, 350);
    assert.equal(r.people.length, 1, 'no phantom person is invented');
});

test('summarise: orders of a deleted user stay attributed to them by name and group', () => {
    const r = pa.summarise({
        users: [mkUser(1, 'Pat')],
        orders: [mkOrder(1, null, 80, { placed_by_name: 'Gone Gary', placed_by_email: 'gary@x.test', placed_by_group: 'Painters' })]
    });
    const gary = r.people.find(p => p.name === 'Gone Gary');
    assert.ok(gary, 'the history keeps its person');
    assert.equal(gary.status, 'removed');
    assert.equal(gary.group, 'Painters');
    assert.equal(gary.spend, 80);
    assert.equal(r.summary.shared_login_orders, 0, 'it is not mistaken for a shared login');
});

test('summarise: high-spend flag needs 3+ people ordering and at least double the average', () => {
    const users = [mkUser(1, 'A'), mkUser(2, 'B'), mkUser(3, 'C')];
    const flagged = pa.summarise({ users, orders: [mkOrder(1, 'u1', 100), mkOrder(2, 'u2', 100), mkOrder(3, 'u3', 400)] });
    assert.deepEqual(flagged.people.filter(p => p.flag).map(p => p.name), ['C']);

    const even = pa.summarise({ users, orders: [mkOrder(1, 'u1', 100), mkOrder(2, 'u2', 120), mkOrder(3, 'u3', 150)] });
    assert.equal(even.people.filter(p => p.flag).length, 0, 'ordinary variation is not an accusation');

    const two = pa.summarise({ users: users.slice(0, 2), orders: [mkOrder(1, 'u1', 10), mkOrder(2, 'u2', 900)] });
    assert.equal(two.people.filter(p => p.flag).length, 0, 'with two people one is always above average');
});

test('summarise: hide-pricing blanks every dollar figure and raises no spend flag', () => {
    const r = pa.summarise({
        users: [mkUser(1, 'A'), mkUser(2, 'B'), mkUser(3, 'C')], hidePricing: true,
        orders: [mkOrder(1, 'u1', 100), mkOrder(2, 'u2', 100), mkOrder(3, 'u3', 4000)]
    });
    assert.equal(r.summary.spend, null);
    assert.equal(r.summary.avg_order, null);
    for (const p of r.people) { assert.equal(p.spend, null); assert.equal(p.avg_order, null); assert.equal(p.share, null); assert.equal(p.flag, null); }
    for (const g of r.groups) assert.equal(g.spend, null);
    assert.equal(r.people.find(p => p.name === 'C').orders, 1, 'counts are still shown');
});

test('summarise: sign-ins, failures and refused shared-code attempts are counted per person', () => {
    const r = pa.summarise({
        users: [mkUser(1, 'Pat')],
        orders: [],
        logins: [
            { user_id: 'u1', event: 'login' }, { user_id: 'u1', event: 'login' }, { user_id: 'u1', event: 'password_set' },
            { user_id: 'u1', event: 'failed' }, { user_id: null, event: 'failed' }, { user_id: null, event: 'shared_refused' }
        ]
    });
    assert.equal(r.people[0].logins, 3);
    assert.equal(r.people[0].failed_logins, 1);
    assert.equal(r.summary.logins, 3);
    assert.equal(r.summary.failed_logins, 2);
    assert.equal(r.summary.shared_code_attempts, 1);
    assert.equal(r.summary.people_signed_in, 1);
});

// =========================================================================
// Groups
// =========================================================================

test('module off: everything refuses with module_off, for CHC and for the owner', async () => {
    seed({ activity: false });
    asSuper();
    const a = await request(app).get(`/api/admin/companies/${CO}/people/groups`);
    assert.equal(a.status, 403);
    assert.equal(a.body.module_off, true);
    const tok = await tokenFor('owner@ns.test');
    const o = await request(app).get('/api/store/northseven/people/activity').set('Authorization', `Bearer ${tok}`);
    assert.equal(o.status, 403);
    assert.equal(o.body.module_off, true);
});

test('the activity module cannot be turned on without Customer users', async () => {
    const { canSetModule } = require('../utils/modules');
    assert.equal(canSetModule({}, 'activity', true).ok, false);
    assert.equal(canSetModule({ users: { enabled: true } }, 'activity', true).ok, true);
});

test('CHC can create, rename and delete groups; names are unique per company ignoring case', async () => {
    seed();
    asSuper();
    const base = `/api/admin/companies/${CO}/people/groups`;
    const made = await request(app).post(base).send({ name: '  Painters  ' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.group.name, 'Painters');

    const dup = await request(app).post(base).send({ name: 'painters' });
    assert.equal(dup.status, 409);

    // the same name is fine in another company
    const other = await request(app).post(`/api/admin/companies/${CO2}/people/groups`).send({ name: 'Painters' });
    assert.equal(other.status, 201);

    const ren = await request(app).put(`${base}/${made.body.group.id}`).send({ name: 'Body techs' });
    assert.equal(ren.status, 200);
    assert.equal((await request(app).get(base)).body.groups[0].name, 'Body techs');

    assert.equal((await request(app).post(base).send({ name: '   ' })).status, 400);
    assert.equal((await request(app).post(base).send({ name: 'x'.repeat(81) })).status, 400);
});

test('assigning people to a group: on invite and by edit; a group from another company is refused', async () => {
    seed();
    asSuper();
    const g = (await request(app).post(`/api/admin/companies/${CO}/people/groups`).send({ name: 'Painters' })).body.group;
    const foreign = (await request(app).post(`/api/admin/companies/${CO2}/people/groups`).send({ name: 'Theirs' })).body.group;

    const set = await request(app).put(`/api/admin/companies/${CO}/users/${U.pat}`).send({ group_id: g.id });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.user.group_id, g.id);

    const bad = await request(app).put(`/api/admin/companies/${CO}/users/${U.sam}`).send({ group_id: foreign.id });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /not part of this company/i);

    const inv = await request(app).post(`/api/admin/companies/${CO}/users`).send({ name: 'Ivy Invited', email: 'ivy@ns.test', group_id: g.id });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    assert.equal(fake.db.company_users.find(u => u.email === 'ivy@ns.test').group_id, g.id);

    const list = await request(app).get(`/api/admin/companies/${CO}/users`);
    assert.equal(list.body.users.find(u => u.id === U.pat).group_name, 'Painters');

    const clear = await request(app).put(`/api/admin/companies/${CO}/users/${U.pat}`).send({ group_id: null });
    assert.equal(clear.body.user.group_id, null);
});

test('deleting a group leaves its people in place, ungrouped, and past orders keep the group name', async () => {
    seed();
    asSuper();
    const g = (await request(app).post(`/api/admin/companies/${CO}/people/groups`).send({ name: 'Painters' })).body.group;
    await request(app).put(`/api/admin/companies/${CO}/users/${U.pat}`).send({ group_id: g.id });
    const tok = await tokenFor('pat@ns.test');
    assert.equal((await order(tok)).status, 201);

    const del = await request(app).delete(`/api/admin/companies/${CO}/people/groups/${g.id}`);
    assert.equal(del.status, 200);
    const pat = fake.db.company_users.find(u => u.id === U.pat);
    assert.ok(pat, 'the person is still there');
    assert.ok(!pat.group_id, 'and ungrouped');
    assert.equal(fake.db.orders[0].placed_by_group, 'Painters', 'the order remembers what group they were in');
});

test('who may do what: order_manager reads but cannot change groups; other admins and order_desk are refused', async () => {
    seed();
    asSuper();
    const g = (await request(app).post(`/api/admin/companies/${CO}/people/groups`).send({ name: 'Painters' })).body.group;

    asManager();
    assert.equal((await request(app).get(`/api/admin/companies/${CO}/people/activity`)).status, 200);
    assert.equal((await request(app).get(`/api/admin/companies/${CO}/people/groups`)).status, 200);
    assert.equal((await request(app).post(`/api/admin/companies/${CO}/people/groups`).send({ name: 'Nope' })).status, 403);
    assert.equal((await request(app).delete(`/api/admin/companies/${CO}/people/groups/${g.id}`)).status, 403);

    asAdminOf(CO);
    assert.equal((await request(app).get(`/api/admin/companies/${CO}/people/activity`)).status, 200);
    assert.equal((await request(app).post(`/api/admin/companies/${CO}/people/groups`).send({ name: 'Mine' })).status, 201);

    asAdminOf(CO2);
    assert.equal((await request(app).get(`/api/admin/companies/${CO}/people/activity`)).status, 403,
        'another customer\'s admin cannot read this customer\'s people');
    assert.equal((await request(app).post(`/api/admin/companies/${CO}/people/groups`).send({ name: 'Mine' })).status, 403);

    asDesk();
    assert.equal((await request(app).get(`/api/admin/companies/${CO}/people/activity`)).status, 403);
});

// =========================================================================
// Sign-in log
// =========================================================================

test('every sign-in attempt that reaches a real company is logged; the answer to the caller is unchanged', async () => {
    seed();
    assert.equal((await signIn('pat@ns.test')).status, 200);
    assert.equal((await signIn('pat@ns.test', 'northseven', 'wrong-Pass-1')).status, 401);
    assert.equal((await signIn('nobody@ns.test')).status, 401);
    fake.db.company_users.find(u => u.id === U.sam).is_active = false;
    assert.equal((await signIn('sam@ns.test')).status, 401);

    const log = fake.db.company_user_logins;
    assert.deepEqual(log.map(l => l.event), ['login', 'failed', 'failed', 'disabled']);
    assert.equal(log[0].user_id, U.pat);
    assert.equal(log[0].company_id, CO);
    assert.equal(log[2].user_id, null, 'an unknown email has no user');
    assert.equal(log[2].email, 'nobody@ns.test');
    for (const l of log) assert.ok(!/pass|token|hash/i.test(JSON.stringify(Object.keys(l))), 'nothing secret is stored');
    assert.ok(!JSON.stringify(log).includes(PW));
});

test('a login that cannot be logged (table missing) still succeeds', async () => {
    seed();
    const orig = fake.db.__insert;
    fake.db.__insert = (t, p) => {
        if (t === 'company_user_logins') { const e = new Error('relation "company_user_logins" does not exist'); e.code = '42P01'; throw e; }
        return orig(t, p);
    };
    const r = await signIn('pat@ns.test');
    assert.equal(r.status, 200, 'a logging problem must never stop someone reaching their store');
});

test('setting a password from an invite is logged as a sign-in', async () => {
    seed();
    fake.db.company_users.find(u => u.id === U.nia).invite_token = 'a'.repeat(64);
    fake.db.company_users.find(u => u.id === U.nia).invite_expires_at = new Date(Date.now() + 1e7).toISOString();
    const r = await request(app).post('/api/auth/company-accept-invite').send({ token: 'a'.repeat(64), password: PW });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(fake.db.company_user_logins.map(l => [l.event, l.user_id]), [['password_set', U.nia]]);
});

// =========================================================================
// Ordering as an individual
// =========================================================================

test('an order is tied to the signed-in person: name, email and group come from the account, not the form', async () => {
    seed();
    asSuper();
    const g = (await request(app).post(`/api/admin/companies/${CO}/people/groups`).send({ name: 'Painters' })).body.group;
    await request(app).put(`/api/admin/companies/${CO}/users/${U.pat}`).send({ group_id: g.id });

    const tok = await tokenFor('pat@ns.test');
    const r = await order(tok, { contact_name: 'Somebody Else', contact_email: 'somebody@else.test' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const o = fake.db.orders[0];
    assert.equal(o.placed_by_user_id, U.pat);
    assert.equal(o.placed_by_name, 'Pat Painter');
    assert.equal(o.placed_by_email, 'pat@ns.test');
    assert.equal(o.placed_by_group, 'Painters');
    assert.equal(o.contact_name, 'Pat Painter', 'cannot order in someone else\'s name');
    assert.equal(o.contact_email, 'pat@ns.test');
});

test('a person who is deactivated cannot order even though their 24-hour token still verifies', async () => {
    seed();
    const tok = await tokenFor('pat@ns.test');
    fake.db.company_users.find(u => u.id === U.pat).is_active = false;
    const r = await order(tok);
    assert.equal(r.status, 401);
    assert.match(r.body.error, /no longer active/i);
    assert.equal(fake.db.orders.length, 0);
});

test('a renamed person is recorded under the new name on the next order, and the old order is untouched', async () => {
    seed();
    const tok = await tokenFor('pat@ns.test');
    await order(tok);
    fake.db.company_users.find(u => u.id === U.pat).name = 'Patricia Painter';
    await order(tok, { po_number: 'PO-2' });
    assert.deepEqual(fake.db.orders.map(o => o.placed_by_name), ['Pat Painter', 'Patricia Painter']);
});

test('an order still goes through if migration 045 has not been applied yet', async () => {
    seed();
    const orig = fake.db.__insert;
    fake.db.__insert = (t, p) => {
        if (t === 'orders' && 'placed_by_name' in p) {
            const e = new Error('column "placed_by_name" of relation "orders" does not exist'); e.code = '42703'; throw e;
        }
        return orig(t, p);
    };
    const tok = await tokenFor('pat@ns.test');
    const r = await order(tok);
    assert.equal(r.status, 201, 'a missing column must not stop a shop ordering');
    assert.equal(fake.db.orders[0].placed_by_user_id, U.pat, 'the person is still recorded');
});

test('a company that does not use People & activity orders exactly as before', async () => {
    seed({ activity: false });
    const tok = await tokenFor('pat@ns.test');
    const r = await order(tok);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(fake.db.orders[0].placed_by_user_id, U.pat);
    // and the shared code still works for it
    const shared = await request(app).post('/api/auth/company-login').send({ slug: 'northseven', access_code: 'shared' });
    assert.equal(shared.status, 200);
});

test('once People & activity is on, the shared access code is refused and the attempt is recorded', async () => {
    seed();
    const r = await request(app).post('/api/auth/company-login').send({ slug: 'northseven', access_code: 'shared' });
    assert.equal(r.status, 403);
    assert.equal(r.body.individual_login_required, true);
    assert.equal(fake.db.company_user_logins.at(-1).event, 'shared_refused');

    const wrong = await request(app).post('/api/auth/company-login').send({ slug: 'northseven', access_code: 'guess' });
    assert.equal(wrong.status, 401, 'a wrong code is still just wrong');
    assert.equal(wrong.body.individual_login_required, undefined);
});

test('a shared-code session opened before the module was switched on cannot place orders', async () => {
    seed({ activity: false });
    const shared = await request(app).post('/api/auth/company-login').send({ slug: 'northseven', access_code: 'shared' });
    const token = shared.body.token;
    fake.db.companies.find(c => c.id === CO).settings.activity = { enabled: true };

    const r = await order(token);
    assert.equal(r.status, 403);
    assert.equal(r.body.individual_login_required, true);
    assert.equal(fake.db.orders.length, 0);
});

// =========================================================================
// The report, end to end
// =========================================================================

async function placeOrders() {
    const pat = await tokenFor('pat@ns.test');
    const sam = await tokenFor('sam@ns.test');
    await order(pat, { items: [{ product_id: PRODUCT, quantity: 1 }], po_number: 'P1' });
    await order(pat, { items: [{ product_id: PRODUCT, quantity: 3 }], po_number: 'P2' });
    await order(sam, { items: [{ product_id: PRODUCT, quantity: 2 }], po_number: 'P3', location_id: LOC2, location: 'York Mills' });
}

test('CHC sees who ordered, how much each person spent, and who signed in', async () => {
    seed();
    asSuper();
    const g = (await request(app).post(`/api/admin/companies/${CO}/people/groups`).send({ name: 'Painters' })).body.group;
    await request(app).put(`/api/admin/companies/${CO}/users/${U.pat}`).send({ group_id: g.id });
    await placeOrders();

    const r = await request(app).get(`/api/admin/companies/${CO}/people/activity`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const pat = r.body.people.find(p => p.name === 'Pat Painter');
    const sam = r.body.people.find(p => p.name === 'Sam Estimator');
    assert.equal(pat.orders, 2);
    assert.equal(pat.units, 4);
    assert.equal(sam.orders, 1);
    assert.ok(pat.spend > sam.spend, 'Pat bought more');
    assert.equal(pat.group, 'Painters');
    assert.equal(pat.logins, 1);
    assert.equal(r.body.summary.orders, 3);
    assert.equal(r.body.summary.people_ordering, 2);
    assert.equal(r.body.pricing_hidden, false);
    assert.ok(r.body.people.find(p => p.name === 'Nia Newhire' && p.orders === 0 && p.status === 'invited'));
    assert.ok(!r.body.people.find(p => p.name === 'Outsider'), 'another company\'s people never appear');
});

test('the report can be filtered by shop, group and date', async () => {
    seed();
    asSuper();
    const g = (await request(app).post(`/api/admin/companies/${CO}/people/groups`).send({ name: 'Painters' })).body.group;
    await request(app).put(`/api/admin/companies/${CO}/users/${U.pat}`).send({ group_id: g.id });
    await placeOrders();

    const york = await request(app).get(`/api/admin/companies/${CO}/people/activity?location_id=${LOC2}`);
    assert.equal(york.body.summary.orders, 1);
    assert.equal(york.body.people.find(p => p.name === 'Sam Estimator').orders, 1);
    assert.ok(!york.body.people.find(p => p.name === 'Pat Painter'), 'a North Seven person who did not order at York Mills is not listed under it');
    assert.ok(york.body.people.find(p => p.name === 'Louie Owner'), 'but someone with no home shop is');

    const grp = await request(app).get(`/api/admin/companies/${CO}/people/activity?group_id=${g.id}`);
    assert.deepEqual(grp.body.people.map(p => p.name), ['Pat Painter']);
    assert.equal(grp.body.summary.orders, 2);

    const future = await request(app).get(`/api/admin/companies/${CO}/people/activity?from=${new Date(Date.now() + 864e5).toISOString()}`);
    assert.equal(future.body.summary.orders, 0);

    const junk = await request(app).get(`/api/admin/companies/${CO}/people/activity?from=not-a-date&group_id=nope&location_id=nope`);
    assert.equal(junk.status, 200, 'bad filters are ignored, not an error');
});

test('one person: their orders and their sign-ins, and no one else\'s', async () => {
    seed();
    asSuper();
    await placeOrders();
    const r = await request(app).get(`/api/admin/companies/${CO}/people/users/${U.pat}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.orders.length, 2);
    assert.ok(r.body.logins.every(l => l.event));
    assert.equal(r.body.user.name, 'Pat Painter');

    assert.equal((await request(app).get(`/api/admin/companies/${CO}/people/users/${U.outsider}`)).status, 404,
        'a person from another company is not reachable through this one');
    assert.equal((await request(app).get(`/api/admin/companies/${CO}/people/users/not-a-uuid`)).status, 400);
});

test('the sign-in log lists newest events with who, what and from where', async () => {
    seed();
    asSuper();
    await signIn('pat@ns.test');
    await signIn('pat@ns.test', 'northseven', 'wrong-Pass-1');
    const r = await request(app).get(`/api/admin/companies/${CO}/people/logins`);
    assert.equal(r.status, 200);
    assert.equal(r.body.logins.length, 2);
    assert.ok(r.body.logins.every(l => 'ip' in l && 'event' in l && 'created_at' in l));
    const only = await request(app).get(`/api/admin/companies/${CO}/people/logins?user_id=${U.sam}`);
    assert.equal(only.body.logins.length, 0);
});

// =========================================================================
// The customer's own owner
// =========================================================================

test('the owner sees their own company\'s report; a member does not', async () => {
    seed();
    await placeOrders();
    const owner = await tokenFor('owner@ns.test');
    const member = await tokenFor('pat@ns.test');

    const ok = await request(app).get('/api/store/northseven/people/activity').set('Authorization', `Bearer ${owner}`);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.summary.orders, 3);

    const no = await request(app).get('/api/store/northseven/people/activity').set('Authorization', `Bearer ${member}`);
    assert.equal(no.status, 403);
    const noGroups = await request(app).post('/api/store/northseven/people/groups').set('Authorization', `Bearer ${member}`).send({ name: 'x' });
    assert.equal(noGroups.status, 403);

    const anon = await request(app).get('/api/store/northseven/people/activity');
    assert.equal(anon.status, 401);
});

test('an owner who is demoted or deactivated loses the report immediately, not when their token lapses', async () => {
    seed();
    const owner = await tokenFor('owner@ns.test');
    const row = fake.db.company_users.find(u => u.id === U.owner);

    row.role = 'member';
    assert.equal((await request(app).get('/api/store/northseven/people/activity').set('Authorization', `Bearer ${owner}`)).status, 403);

    row.role = 'owner'; row.is_active = false;
    assert.equal((await request(app).get('/api/store/northseven/people/activity').set('Authorization', `Bearer ${owner}`)).status, 401);
});

test('the owner can manage groups and put their people in them, but only within their own company', async () => {
    seed();
    const owner = await tokenFor('owner@ns.test');
    const auth = { Authorization: `Bearer ${owner}` };
    const g = await request(app).post('/api/store/northseven/people/groups').set(auth).send({ name: 'Estimators' });
    assert.equal(g.status, 201, JSON.stringify(g.body));

    const set = await request(app).put(`/api/store/northseven/users/${U.sam}`).set(auth).send({ group_id: g.body.group.id });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(fake.db.company_users.find(u => u.id === U.sam).group_id, g.body.group.id);

    const cross = await request(app).put(`/api/store/northseven/users/${U.outsider}`).set(auth).send({ group_id: g.body.group.id });
    assert.equal(cross.status, 404, 'cannot reach another company\'s person');
});

test('hide-pricing: the owner sees counts but no dollars; CHC still sees dollars', async () => {
    seed({ hidePricing: true });
    await placeOrders();
    const owner = await tokenFor('owner@ns.test');
    const r = await request(app).get('/api/store/northseven/people/activity').set('Authorization', `Bearer ${owner}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.pricing_hidden, true);
    assert.equal(r.body.summary.spend, null);
    assert.ok(r.body.people.every(p => p.spend === null));
    const one = await request(app).get(`/api/store/northseven/people/users/${U.pat}`).set('Authorization', `Bearer ${owner}`);
    assert.ok(one.body.orders.every(o => o.total === null));

    asSuper();
    const staff = await request(app).get(`/api/admin/companies/${CO}/people/activity`);
    assert.equal(staff.body.pricing_hidden, false);
    assert.ok(staff.body.summary.spend > 0);
});

test('the report is not cut off at 1,000 orders', async () => {
    seed();
    asSuper();
    for (let i = 0; i < 1250; i++) {
        fake.db.orders.push({ id: `bulk-${i}`, company_id: CO, status: 'pending', total: 10, items: [{ quantity: 1 }], placed_by_user_id: U.pat, created_at: new Date().toISOString() });
    }
    const r = await request(app).get(`/api/admin/companies/${CO}/people/activity`);
    assert.equal(r.body.summary.orders, 1250);
    assert.equal(r.body.people.find(p => p.name === 'Pat Painter').orders, 1250);
});

test('the users list works whether or not the group columns exist yet', async () => {
    seed();
    asSuper();
    const g = (await request(app).post(`/api/admin/companies/${CO}/people/groups`).send({ name: 'Painters' })).body.group;
    await request(app).put(`/api/admin/companies/${CO}/users/${U.pat}`).send({ group_id: g.id });
    const withGroups = await request(app).get(`/api/admin/companies/${CO}/users`);
    assert.equal(withGroups.body.users.find(u => u.id === U.pat).group_name, 'Painters');

    // Simulate a database without migration 045: the grouped select errors.
    const origFrom = fake.from.bind(fake);
    fake.from = table => {
        const q = origFrom(table);
        if (table !== 'company_users') return q;
        const origSelect = q.select.bind(q);
        q.select = (cols, o) => {
            if (String(cols).includes('group_id')) {
                return { eq: () => ({ order: async () => ({ data: null, error: { message: 'column company_users.group_id does not exist' } }) }) };
            }
            return origSelect(cols, o);
        };
        return q;
    };
    const without = await request(app).get(`/api/admin/companies/${CO}/users`);
    fake.from = origFrom;
    assert.equal(without.status, 200);
    assert.equal(without.body.users.length, 4, 'the list must not collapse to empty');
    assert.equal(without.body.users.find(u => u.id === U.pat).group_name, null);
});

// =========================================================================
// The shared screen's own helpers (public/people-activity.js)
// =========================================================================

test('screen: period ranges are what a manager expects, in their own time', () => {
    const w = require('../public/people-activity.js');
    const now = new Date(2026, 9, 16, 15, 30);   // 16 Oct 2026, local
    const thisMonth = w.periodRange('this_month', now);
    assert.equal(new Date(thisMonth.from).getTime(), new Date(2026, 9, 1).getTime());
    assert.equal(thisMonth.to, null);

    const last = w.periodRange('last_month', now);
    assert.equal(new Date(last.from).getTime(), new Date(2026, 8, 1).getTime());
    assert.ok(new Date(last.to).getTime() < new Date(2026, 9, 1).getTime(), 'ends before this month starts');
    assert.ok(new Date(last.to).getTime() >= new Date(2026, 8, 30, 23, 59).getTime());

    const d30 = w.periodRange('last_30', now);
    assert.equal(Math.round((new Date(2026, 9, 16).getTime() - new Date(d30.from).getTime()) / 864e5), 29, '30 days including today');

    assert.deepEqual(w.periodRange('all', now), { from: null, to: null });
    assert.equal(new Date(w.periodRange('ytd', now).from).getTime(), new Date(2026, 0, 1).getTime());
});

test('screen: devices are shown plainly and money in Canadian dollars', () => {
    const w = require('../public/people-activity.js');
    assert.equal(w.device('Mozilla/5.0 (iPhone; CPU iPhone OS 17) Safari/604.1'), 'Safari on iOS');
    assert.equal(w.device('Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537'), 'Chrome on Windows');
    assert.equal(w.device(''), '');
    assert.match(w.money(1234.5), /1,234\.50/);
    assert.equal(w.money(null), '—', 'a hidden figure is a dash, never $0');
});
