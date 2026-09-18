/**
 * tests/staff-access.test.js
 *
 * Migration 041: an order_desk account can be assigned to more than one CHC
 * branch and, optionally, narrowed to specific customers within them --
 * generalizing the single admin_users.branch_id column from migration 020.
 *
 * Covers three layers:
 *   1. utils/order-scope.js -- staffBranchIds / staffCompanyIds / staffLocationIds,
 *      the actual union + narrowing logic that decides order visibility.
 *   2. utils/recipients.js -- branchStaffEmails, so assigning someone to a
 *      branch in the Users screen puts them on that branch's order emails
 *      without touching the manually-curated supplier_branches.emails list.
 *   3. routes/admin-users.js -- the HTTP surface: create/list/assign, the
 *      status + warning the Users screen shows for each account, and that
 *      order_manager (already offered in the console's role dropdown) can
 *      actually be created, which it could not be before this change.
 *
 * Harness copied from tests/company-notes-and-backorder.test.js.
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
const sentInvites = [];

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
const { staffBranchIds, staffCompanyIds, staffLocationIds } = require('../utils/order-scope');
const { branchStaffEmails, resolveOrderRecipients } = require('../utils/recipients');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

/**
 * A deterministic, UUID-shaped id for a human-readable label. The HTTP routes
 * validate every id (isValidUUID, the real one -- not stubbed here on
 * purpose, since it's exactly what admin-users.js relies on to reject junk),
 * so anything that crosses an HTTP boundary in section 3 needs to look like a
 * real id; the direct function-level tests in sections 1-2 don't.
 */
function uid(label) {
    const hex = require('node:crypto').createHash('sha1').update(label).digest('hex').slice(0, 12);
    return `aaaaaaaa-bbbb-4ccc-8ddd-${hex}`;
}

function asSuperAdmin(id = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001') {
    authAdmin = { id, email: 'adam@chcpaint.com', name: 'Adam', role: 'super_admin', is_active: true, must_change_password: false };
}

function seedBranch(id, name, emails = []) {
    fake.db.supplier_branches.push({ id, name, emails, city: null, is_active: true, created_at: new Date().toISOString() });
}
function seedCompany(id, name) {
    fake.db.companies.push({ id, name, slug: name.toLowerCase(), is_active: true });
}
function seedStaff(id, patch) {
    fake.db.admin_users = fake.db.admin_users || [];
    fake.db.admin_users.push({
        id, email: `${id.slice(-6)}@chcpaint.com`, name: id, role: 'order_desk',
        company_id: null, branch_id: null, is_active: true, must_change_password: false,
        password_hash: 'hash', invite_expires_at: null, is_branch_manager: false,
        created_at: new Date().toISOString(),
        ...patch
    });
}

// ----------------------------------------------------------------------
// 1. utils/order-scope.js -- staffBranchIds / staffCompanyIds / staffLocationIds
// ----------------------------------------------------------------------

test('staffBranchIds unions the legacy branch_id with admin_user_branches rows', async () => {
    seedBranch('branch-a', 'A'); seedBranch('branch-b', 'B'); seedBranch('branch-c', 'C');
    const admin = { id: 'staff-1', branch_id: 'branch-a' };
    fake.db.admin_user_branches.push({ admin_user_id: 'staff-1', branch_id: 'branch-b' });
    fake.db.admin_user_branches.push({ admin_user_id: 'staff-1', branch_id: 'branch-a' }); // dup with legacy column -- must not double up

    const ids = await staffBranchIds(admin);
    assert.deepEqual([...ids].sort(), ['branch-a', 'branch-b']);
});

test('staffBranchIds returns nothing for an account with no legacy branch and no rows', async () => {
    const ids = await staffBranchIds({ id: 'staff-nobody', branch_id: null });
    assert.deepEqual(ids, []);
});

test('staffCompanyIds is empty (no narrowing) until a row exists', async () => {
    const ids = await staffCompanyIds({ id: 'staff-1' });
    assert.deepEqual(ids, []);
});

test('staffLocationIds: every location under the assigned branches, with no company narrowing', async () => {
    seedCompany('co-1', 'Concord Collision');
    seedCompany('co-2', 'Other Shop');
    fake.db.company_locations.push({ id: 'loc-1', company_id: 'co-1', supplier_branch_id: 'branch-a', name: 'Main' });
    fake.db.company_locations.push({ id: 'loc-2', company_id: 'co-2', supplier_branch_id: 'branch-a', name: 'Main' });
    fake.db.company_locations.push({ id: 'loc-3', company_id: 'co-1', supplier_branch_id: 'branch-c', name: 'Other' });

    // staff-1 is on branch-a and branch-b (from the test above) -- branch-c is not assigned.
    const ids = await staffLocationIds({ id: 'staff-1', branch_id: 'branch-a' });
    assert.deepEqual([...ids].sort(), ['loc-1', 'loc-2']);
});

test('staffLocationIds narrows to assigned customers when admin_user_companies has rows', async () => {
    fake.db.admin_user_companies.push({ admin_user_id: 'staff-1', company_id: 'co-1' });
    const ids = await staffLocationIds({ id: 'staff-1', branch_id: 'branch-a' });
    // Same branches as before, but now only co-1's location -- co-2 is filtered out.
    assert.deepEqual(ids, ['loc-1']);
});

test('staffLocationIds is empty for an account with no branch assignment at all', async () => {
    const ids = await staffLocationIds({ id: 'staff-ghost', branch_id: null });
    assert.deepEqual(ids, []);
});

// ----------------------------------------------------------------------
// 2. utils/recipients.js -- branchStaffEmails / resolveOrderRecipients
// ----------------------------------------------------------------------

test('branchStaffEmails returns active staff assigned to the branch, deduped, inactive dropped', async () => {
    seedStaff('staff-active-1', { branch_id: 'branch-a', is_active: true, email: 'active-desk@chcpaint.com' });
    seedStaff('staff-disabled', { branch_id: 'branch-a', is_active: false, email: 'disabled-desk@chcpaint.com' });
    fake.db.admin_user_branches.push({ admin_user_id: 'staff-active-1', branch_id: 'branch-a' }); // legacy + new row for same account

    const emails = await branchStaffEmails('branch-a');
    assert.deepEqual(emails, ['active-desk@chcpaint.com']);
});

test('resolveOrderRecipients unions the manual branch list with assigned staff emails', async () => {
    seedBranch('branch-e', 'Email Test', ['shared-inbox@chcpaint.com']);
    seedCompany('co-e', 'Email Co');
    fake.db.company_locations.push({ id: 'loc-e', company_id: 'co-e', supplier_branch_id: 'branch-e', notify_emails: [] });
    seedStaff('staff-e', { branch_id: 'branch-e', is_active: true, email: 'staffer@chcpaint.com' });

    const { staffTo, to } = await resolveOrderRecipients({ company_id: 'co-e', location_id: 'loc-e', contact_email: 'buyer@shop.com' });
    assert.deepEqual(staffTo.sort(), ['shared-inbox@chcpaint.com', 'staffer@chcpaint.com'].sort());
    assert.ok(to.includes('shared-inbox@chcpaint.com') && to.includes('staffer@chcpaint.com') && to.includes('buyer@shop.com'));
});

// ----------------------------------------------------------------------
// 3. routes/admin-users.js -- HTTP surface
// ----------------------------------------------------------------------

test('creating an order_desk account with branch_ids + company_ids persists both and syncs legacy branch_id', async () => {
    asSuperAdmin();
    const bx = uid('branch-x'), by = uid('branch-y'), cx = uid('co-x');
    seedBranch(bx, 'Xbranch'); seedBranch(by, 'Ybranch');
    seedCompany(cx, 'X Customer');

    const resp = await request(app).post('/api/admin/users').send({
        name: 'New Desk', email: 'newdesk@chcpaint.com', role: 'order_desk',
        branch_ids: [bx, by], company_ids: [cx]
    });
    assert.equal(resp.status, 201);
    assert.deepEqual(resp.body.user.branch_ids.sort(), [bx, by].sort());
    assert.deepEqual(resp.body.user.company_ids, [cx]);

    const stored = fake.db.admin_users.find(u => u.email === 'newdesk@chcpaint.com');
    // The FIRST assigned branch, kept in sync for anything still reading the
    // single legacy column (the JWT payload, /whoami, the invite email).
    assert.equal(stored.branch_id, bx);
});

test('order_manager can now be created (the console dropdown already offered it, the API refused it)', async () => {
    asSuperAdmin();
    const resp = await request(app).post('/api/admin/users').send({
        name: 'Head Office', email: 'headoffice@chcpaint.com', role: 'order_manager'
    });
    assert.equal(resp.status, 201);
    assert.equal(resp.body.user.role, 'order_manager');
    const stored = fake.db.admin_users.find(u => u.email === 'headoffice@chcpaint.com');
    assert.equal(stored.role, 'order_manager');
    assert.equal(stored.branch_id, null); // order_manager is never scoped by branch
});

test('branch_ids sent for an order_manager are ignored -- the role is never assignable', async () => {
    asSuperAdmin();
    const bi = uid('branch-ignored');
    seedBranch(bi, 'Ignored');
    const resp = await request(app).post('/api/admin/users').send({
        name: 'Manager Two', email: 'managertwo@chcpaint.com', role: 'order_manager', branch_ids: [bi]
    });
    assert.equal(resp.status, 201);
    const rows = fake.db.admin_user_branches.filter(r =>
        r.admin_user_id === fake.db.admin_users.find(u => u.email === 'managertwo@chcpaint.com').id);
    assert.equal(rows.length, 0);
});

test('an order_desk account with nothing assigned is created successfully and flagged with a warning, not refused', async () => {
    asSuperAdmin();
    const resp = await request(app).post('/api/admin/users').send({
        name: 'Blank Slate', email: 'blank@chcpaint.com', role: 'order_desk'
    });
    assert.equal(resp.status, 201);

    const list = await request(app).get('/api/admin/users');
    const row = list.body.users.find(u => u.email === 'blank@chcpaint.com');
    assert.equal(row.status, 'invited'); // no password set yet -- separate from the access warning
    assert.match(row.warning, /cannot see any orders/);
});

test('PUT /:id/assignments replaces the set -- adding and removing in the same call', async () => {
    asSuperAdmin();
    const p1 = uid('branch-p1'), p2 = uid('branch-p2');
    seedBranch(p1, 'P1'); seedBranch(p2, 'P2');
    await request(app).post('/api/admin/users').send({
        name: 'Picker Test', email: 'picker@chcpaint.com', role: 'order_desk', branch_ids: [p1]
    });
    const id = fake.db.admin_users.find(u => u.email === 'picker@chcpaint.com').id;

    const put = await request(app).put(`/api/admin/users/${id}/assignments`).send({ branch_ids: [p2], company_ids: [] });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.branch_ids, [p2]);

    const stillThere = fake.db.admin_user_branches.filter(r => r.admin_user_id === id);
    assert.deepEqual(stillThere.map(r => r.branch_id), [p2]);
    assert.equal(fake.db.admin_users.find(u => u.id === id).branch_id, p2);
});

test('PUT /:id/assignments silently drops an id that does not exist', async () => {
    asSuperAdmin();
    await request(app).post('/api/admin/users').send({
        name: 'Ghost Branch', email: 'ghostbranch@chcpaint.com', role: 'order_desk'
    });
    const id = fake.db.admin_users.find(u => u.email === 'ghostbranch@chcpaint.com').id;
    const nonExistentButValidUuid = uid('never-seeded-branch');

    const put = await request(app).put(`/api/admin/users/${id}/assignments`).send({ branch_ids: [nonExistentButValidUuid], company_ids: [] });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.branch_ids, []);
});

test('PUT /:id/assignments is refused for a role that is not order_desk', async () => {
    asSuperAdmin();
    const id = fake.db.admin_users.find(u => u.email === 'headoffice@chcpaint.com').id;
    const put = await request(app).put(`/api/admin/users/${id}/assignments`).send({ branch_ids: [] });
    assert.equal(put.status, 400);
});

test('changing role away from order_desk clears its assignment rows and legacy branch_id', async () => {
    asSuperAdmin();
    const bc = uid('branch-clear');
    seedBranch(bc, 'Clear');
    await request(app).post('/api/admin/users').send({
        name: 'Soon Promoted', email: 'promoted@chcpaint.com', role: 'order_desk', branch_ids: [bc]
    });
    const id = fake.db.admin_users.find(u => u.email === 'promoted@chcpaint.com').id;

    const put = await request(app).put(`/api/admin/users/${id}`).send({ role: 'super_admin' });
    assert.equal(put.status, 200);
    assert.equal(put.body.user.branch_id, null);
    assert.equal(fake.db.admin_user_branches.filter(r => r.admin_user_id === id).length, 0);
});

test('GET /:id/assignments returns the union used for scoping, including a legacy-only account', async () => {
    asSuperAdmin();
    const bl = uid('branch-legacy'), sl = uid('staff-legacy');
    seedBranch(bl, 'Legacy Only');
    seedStaff(sl, { branch_id: bl, email: 'legacy-staff@chcpaint.com' });
    const resp = await request(app).get(`/api/admin/users/${sl}/assignments`);
    assert.equal(resp.status, 200);
    assert.deepEqual(resp.body.branch_ids, [bl]);
    assert.equal(resp.body.assignable, true);
});
