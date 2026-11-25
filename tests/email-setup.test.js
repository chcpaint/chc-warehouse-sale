/**
 * tests/email-setup.test.js
 *
 * The Order emails screen (GET /companies/:id/email-setup): every shop lists
 * everyone who actually gets its order emails, the same as the sending code.
 *
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



function reset(opts = {}) {
    fake = createFakeSupabase({
        distributors: [{ id: CHC_ID, name: 'CHC Paint & Auto Body Supplies', slug: 'chc', custom_domain: null, is_active: true, is_default: true, settings: { order_status_mode: 'simplified' } }],
        companies: [{ id: CO, distributor_id: CHC_ID, name: 'Assured Collision', slug: 'assured', is_active: true, contact_email: 'shop@example.invalid', email_config: {}, settings: opts.companySettings || {} }],
        company_locations: [{ id: LOC, company_id: CO, name: 'Main', is_active: true, supplier_branch_id: BRANCH_MARKHAM, notify_emails: [], restrict_to_category: null }],
        supplier_branches: [{ id: BRANCH_MARKHAM, name: 'Markham', emails: ['markham@chc.example'], is_active: true }],
        products: [{ id: PRODUCT, company_id: CO, sku: 'W-1', name: 'Widget', brand: '3M', category: 'Abrasives', price: 25, is_active: true, price_on_request: false }],
        company_fee_rules: opts.fee || [],
        company_rebate_rules: opts.rebate || [],
        company_user_groups: [], company_users: [],
        orders: [{
            id: ORDER, company_id: CO, order_number: 'CHC-1001', contact_name: 'Pat', contact_email: 'pat@example.invalid', contact_phone: '555',
            company_name: 'Assured Collision', location: 'Main', location_id: LOC,
            items: [{ product_id: PRODUCT, name: 'Widget', sku: 'W-1', quantity: 20, unit_price: 25, subtotal: 500, price_on_request: false }],
            subtotal: 500, tax: 0, tax_rate: 0, delivery_fee: 0, total: 500, notes: '', status: 'closed',
            status_history: [], is_partial_shipment: false, notes_log: [], created_at: '2026-09-15T15:00:00Z'
        }],
        audit_log: []
    });
    authAdmin = SUPER_ADMIN;
    authCompany = { id: CO, name: 'Assured Collision', slug: 'assured' };
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

const LOC2 = '33333333-3333-4333-8333-333333333334';
const STAFF_ON = { id: 'a5555555-5555-4555-8555-555555555555', role: 'order_desk', name: 'Asaad', email: 'asaad@chc.example', is_active: true, branch_id: null, company_id: null };
const STAFF_OFF = { id: 'a6666666-6666-4666-8666-666666666666', role: 'order_desk', name: 'Gone', email: 'gone@chc.example', is_active: false, branch_id: BRANCH_MARKHAM, company_id: null };

function setup() {
    reset();
    fake.db.companies[0].contact_email = 'ap@shop.example';
    fake.db.companies[0].email_config = { manager_emails: ['boss@shop.example', 'AP@shop.example'] };
    fake.db.company_locations[0].name = 'York Mills';
    fake.db.company_locations[0].notify_emails = ['bav@shop.example', 'kartik@shop.example'];
    fake.db.company_locations.push({ id: LOC2, company_id: CO, name: 'No branch shop', is_active: true, supplier_branch_id: null, notify_emails: [] });
    fake.db.admin_users.push(STAFF_ON, STAFF_OFF);
    fake.db.admin_user_branches.push({ admin_user_id: STAFF_ON.id, branch_id: BRANCH_MARKHAM });
}

test('each shop lists everyone who gets its order emails, including CHC staff assigned in Admin Users', async () => {
    setup();
    const r = await request(adminApp()).get(`/api/admin/companies/${CO}/email-setup`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ym = r.body.locations.find(l => l.name === 'York Mills');
    assert.deepEqual(ym.branch_staff, ['asaad@chc.example']);
    assert.deepEqual(ym.everyone, [
        { email: 'bav@shop.example', from: 'shop' },
        { email: 'kartik@shop.example', from: 'shop' },
        { email: 'ap@shop.example', from: 'company_contact' },
        { email: 'boss@shop.example', from: 'company_group' },
        { email: 'markham@chc.example', from: 'branch' },
        { email: 'asaad@chc.example', from: 'branch_staff' }
    ]);
    const none = r.body.locations.find(l => l.name === 'No branch shop');
    assert.deepEqual(none.branch_staff, []);
    assert.deepEqual(none.everyone.map(x => x.from), ['company_contact', 'company_group']);
});

test('the list matches who the sending code actually emails', async () => {
    setup();
    const { resolveOrderRecipients } = require('../utils/recipients');
    const r = await request(adminApp()).get(`/api/admin/companies/${CO}/email-setup`);
    const ym = r.body.locations.find(l => l.name === 'York Mills');
    const sent = await resolveOrderRecipients({ company_id: CO, location_id: LOC });
    assert.deepEqual([...ym.everyone.map(x => x.email)].sort(), [...sent.to].sort());
});

test('a switched-off branch shows no CHC recipients, as nothing is sent to it', async () => {
    setup();
    fake.db.supplier_branches[0].is_active = false;
    const r = await request(adminApp()).get(`/api/admin/companies/${CO}/email-setup`);
    const ym = r.body.locations.find(l => l.name === 'York Mills');
    assert.equal(ym.branch_active, false);
    assert.ok(!ym.everyone.some(x => x.from === 'branch' || x.from === 'branch_staff'));
});
