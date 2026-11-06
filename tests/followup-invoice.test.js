/**
 * tests/followup-invoice.test.js
 *
 * The second ("follow-up") invoice for an order that shipped partially with a
 * backorder. It works like the first invoice: the console shows it as "needs
 * upload" until a file is there, the customer can download it, the first
 * invoice is never replaced by it, and the order cannot be closed while one is
 * still owed unless staff say, explicitly, that none is needed.
 *
 *   node --test tests/followup-invoice.test.js
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
let authCompany = null;
let authCompanyUser = null;

const sentEmails = { status: [], notes: [], notifications: [], contact: [], invoice: [] };

// utils/order-scope.js is deliberately NOT stubbed (companyInScope and
// orderInScope are what's under test here too), so it must resolve
// utils/supabase to the fake before middleware/auth.js is ever required.
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
        sendContactNote: async (o) => { sentEmails.contact.push(o); return { sent: true }; },
        sendInvoiceReady: async (o) => { sentEmails.invoice.push(o); return { sent: true }; },
        sendOrderClosed: async () => ({ sent: true }),
        sendLowStockAlert: async () => ({ sent: true }),
        sendReorderRaised: async () => ({ sent: true }),
        sendInvite: async () => ({ sent: true })
    },
    [path.join(ROOT, 'middleware/upload.js')]: {
        catalogUpload: { single: () => (req, res, next) => next() },
        logoUpload: { single: () => (req, res, next) => next() },
        invoiceUpload: { single: () => (req, res, next) => {
            const name = req.get('x-test-file');
            if (name) req.file = { originalname: name, buffer: Buffer.from('%PDF-1.4 test'), mimetype: 'application/pdf' };
            next();
        } }
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
const CO_OTHER = '11111111-1111-4111-8111-111111111199';
const BRANCH_MARKHAM = 'd0000000-0000-4000-8000-000000000001';
const BRANCH_OTHER = 'd0000000-0000-4000-8000-000000000002';
const LOC = '33333333-3333-4333-8333-333333333333';
const PRODUCT = '55555555-5555-4555-8555-555555555555';
const PRODUCT2 = '55555555-5555-4555-8555-555555555556';
const ORDER = 'e0000000-0000-4000-8000-000000000001';

const SUPER_ADMIN = { id: 'a1111111-1111-4111-8111-111111111111', role: 'super_admin', name: 'Sam Super', email: 'sam@chc.example', company_id: null, branch_id: null };
const ORDER_DESK_MARKHAM = { id: 'a2222222-2222-4222-8222-222222222222', role: 'order_desk', name: 'Dana Desk', email: 'dana@chc.example', company_id: null, branch_id: BRANCH_MARKHAM };
const ORDER_DESK_OTHER = { id: 'a3333333-3333-4333-8333-333333333333', role: 'order_desk', name: 'Otto Other', email: 'otto@chc.example', company_id: null, branch_id: BRANCH_OTHER };
const ORDER_MANAGER = { id: 'a4444444-4444-4444-8444-444444444444', role: 'order_manager', name: 'Mo Manager', email: 'mo@chc.example', company_id: null, branch_id: null };
const COMPANY_ADMIN = { id: 'a5555555-5555-4555-8555-555555555555', role: 'company_admin', name: 'Cara Company', email: 'cara@chc.example', company_id: CO, branch_id: null };

function baseOrder(overrides = {}) {
    return {
        id: ORDER, company_id: CO, order_number: 'CHC-1001',
        contact_name: 'Pat Painter', contact_email: 'pat@example.invalid', contact_phone: '555-0100',
        company_name: 'Assured Collision', location: 'Main', location_id: LOC,
        items: [
            { product_id: PRODUCT, name: 'Widget', sku: 'W-1', quantity: 5, unit_price: 25, subtotal: 125, price_on_request: false },
            { product_id: PRODUCT2, name: 'Sprocket', sku: 'S-2', quantity: 3, unit_price: 10, subtotal: 30, price_on_request: false }
        ],
        subtotal: 155, tax: 20.15, tax_rate: 0.13, delivery_fee: 10, total: 185.15,
        notes: '', status: 'pending', status_history: [], is_partial_shipment: false, notes_log: [],
        backorder_items: [],
        ...overrides
    };
}

function reset(opts = {}) {
    fake = createFakeSupabase({
        distributors: [
            { id: CHC_ID, name: 'CHC Paint & Auto Body Supplies', slug: 'chc', custom_domain: null, is_active: true, is_default: true, settings: opts.distributorSettings ?? { order_status_mode: 'simplified' } }
        ],
        companies: [
            { id: CO, distributor_id: CHC_ID, name: 'Assured Collision', slug: 'assured', is_active: true, contact_email: 'shop@example.invalid', email_config: {}, settings: opts.companySettings || {} },
            { id: CO_OTHER, distributor_id: CHC_ID, name: 'Bayview Auto Body', slug: 'bayview', is_active: true, contact_email: 'bayview@example.invalid', email_config: {}, settings: {} }
        ],
        company_locations: [
            { id: LOC, company_id: CO, name: 'Main', is_active: true, supplier_branch_id: BRANCH_MARKHAM, notify_emails: [], restrict_to_category: null }
        ],
        supplier_branches: [
            { id: BRANCH_MARKHAM, name: 'Markham', emails: ['markham@chc.example'], is_active: true },
            { id: BRANCH_OTHER, name: 'Other Branch', emails: ['other@chc.example'], is_active: true }
        ],
        products: [
            { id: PRODUCT, company_id: CO, sku: 'W-1', name: 'Widget', price: 25, is_active: true, price_on_request: false },
            { id: PRODUCT2, company_id: CO, sku: 'S-2', name: 'Sprocket', price: 10, is_active: true, price_on_request: false }
        ],
        orders: [baseOrder(opts.orderOverrides)],
        company_notes: opts.companyNotes || [],
        audit_log: []
    });
    authAdmin = SUPER_ADMIN;
    authCompany = { id: CO, name: 'Assured Collision', slug: 'assured' };
    authCompanyUser = null;
    sentEmails.status = []; sentEmails.notes = []; sentEmails.notifications = []; sentEmails.contact = []; sentEmails.invoice = [];
}

function adminApp() {
    const a = express();
    a.use(express.json());
    a.use((req, res, next) => {
        const d = fake.db.distributors[0];
        req.distributor = d ? { id: d.id, name: d.name, slug: d.slug, settings: d.settings } : null;
        next();
    });
    a.use('/api/admin', adminRoutes);
    return a;
}

function storeApp() {
    const a = express();
    a.use(express.json());
    a.use((req, res, next) => {
        const d = fake.db.distributors[0];
        req.distributor = d ? { id: d.id, name: d.name, slug: d.slug, settings: d.settings } : null;
        next();
    });
    a.use('/api/store', storefrontRoutes);
    return a;
}

// ==================================================================
// 1. company_notes — admin side (routes/contact-notes-admin.js)
// ==================================================================


// ------------------------------------------------------------------
const A = `/api/admin`;
const base = () => `/api/admin/companies/${CO}/orders/${ORDER}`;
const partial = (items = [{ product_id: PRODUCT, quantity: 2 }]) => request(adminApp())
    .put(`/api/admin/orders/${ORDER}/status`)
    .send({ status: 'out_on_delivery', is_partial_shipment: true, backorder_items: items });
const upload = (kind, name) => request(adminApp()).post(`${base()}/${kind}`).set('x-test-file', name);
const row = () => fake.db.orders.find(o => o.id === ORDER);

test('recording a partial shipment marks a follow-up invoice as owed, and remembers what was short', async () => {
    reset();
    const r = await partial();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(row().followup_invoice_due, true);
    assert.deepEqual(row().followup_invoice_items.map(i => [i.name, i.quantity]), [['Widget', 2]]);
    assert.equal(row().followup_invoice_filename || null, null);
});

test('it stays owed after the backorder ships and the partial flag is cleared', async () => {
    reset();
    await partial();
    const r = await request(adminApp()).put(`/api/admin/orders/${ORDER}/status`).send({ status: 'out_on_delivery', is_partial_shipment: false });
    assert.equal(r.status, 200);
    assert.equal(row().is_partial_shipment, false);
    assert.deepEqual(row().backorder_items, []);
    assert.equal(row().followup_invoice_due, true, 'still owed');
    assert.equal(row().followup_invoice_items.length, 1, 'what was short is still on record');
});

test('an order that never shipped partially owes nothing', async () => {
    reset();
    await request(adminApp()).put(`/api/admin/orders/${ORDER}/status`).send({ status: 'out_on_delivery' });
    assert.ok(!row().followup_invoice_due);
    const c = await request(adminApp()).put(`${base()}/close`).send({});
    assert.equal(c.status, 200, 'closes as before');
});

test('the follow-up invoice is stored in its own slot and never replaces the first invoice', async () => {
    reset();
    await upload('invoice', 'first.pdf').send();
    await partial();
    const r = await upload('followup-invoice', 'second.pdf').send();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.message, /Follow-up invoice uploaded/);
    assert.equal(row().invoice_filename, 'first.pdf');
    assert.equal(row().followup_invoice_filename, 'second.pdf');
    assert.notEqual(row().invoice_path, row().followup_invoice_path);
    assert.match(row().followup_invoice_path, new RegExp(`^${CO}/${ORDER}/followup-invoice-`));
    assert.ok(row().followup_invoice_uploaded_at && row().followup_invoice_uploaded_by);
    assert.ok(fake.db.audit_log.some(a => a.action === 'followup_invoice_uploaded'));
    // both files really were stored
    const stored = Object.keys(fake.__storage.invoices || {});
    assert.equal(stored.length, 2);
});

test('uploading the first invoice again does not touch the follow-up', async () => {
    reset();
    await partial();
    await upload('followup-invoice', 'second.pdf').send();
    await upload('invoice', 'first-v2.pdf').send();
    assert.equal(row().invoice_filename, 'first-v2.pdf');
    assert.equal(row().followup_invoice_filename, 'second.pdf');
});

test('follow-up upload needs a file, and the right access', async () => {
    reset();
    assert.equal((await request(adminApp()).post(`${base()}/followup-invoice`).send()).status, 400);
    authAdmin = ORDER_DESK_OTHER;   // a branch that does not serve this order
    assert.equal((await upload('followup-invoice', 'x.pdf').send()).status, 403);
    assert.equal(row().followup_invoice_filename || null, null);
    authAdmin = ORDER_DESK_MARKHAM; // the serving branch: same reach as for the first invoice
    assert.equal((await upload('followup-invoice', 'x.pdf').send()).status, 200);
    assert.equal((await request(adminApp()).get(`${base()}/followup-invoice`)).status, 200);
    assert.equal((await request(adminApp()).put(`${base()}/followup-invoice/waive`).send({})).status, 409, 'allowed in (not 403); nothing owed to waive now that it is uploaded');
});

test('the recipients get a "follow-up invoice" email that lists the backordered items', async () => {
    reset();
    await upload('invoice', 'first.pdf').send();
    assert.equal(sentEmails.invoice.at(-1).followUp, false);
    await partial([{ product_id: PRODUCT, quantity: 2 }]);
    await upload('followup-invoice', 'second.pdf').send();
    await new Promise(r => setImmediate(r));
    const mail = sentEmails.invoice.at(-1);
    assert.equal(mail.followUp, true);
    assert.deepEqual(mail.backorderItems.map(i => [i.name, i.quantity]), [['Widget', 2]]);
});

test('the real email says "follow-up invoice" and names the items', async () => {
    const emailPath = path.join(ROOT, 'utils/email.js');
    delete require.cache[emailPath];
    Module._load = originalLoad;   // load the real module, not the stub
    const sent = [];
    const sg = require('@sendgrid/mail');
    sg.setApiKey('SG.test'); sg.send = async (m) => { sent.push(m); };
    process.env.SENDGRID_API_KEY = 'SG.test'; process.env.SMTP_FROM = 'noreply@example.invalid';
    const real = require(emailPath);
    const r = await real.sendInvoiceReady({ to: 'a@b.invalid', order: { order_number: 'CHC-1001' }, companyName: 'Assured', retrieveUrl: 'https://x.invalid/store/assured', followUp: true, backorderItems: [{ name: 'Widget <b>', sku: 'W-1', quantity: 2 }] });
    assert.equal(r.sent, true, JSON.stringify(r));
    {
        assert.match(sent[0].subject, /^Follow-up invoice ready/);
        assert.match(sent[0].html, /Follow-up Invoice Ready/);
        assert.match(sent[0].html, /2 &times; Widget &lt;b&gt;/, 'item names are escaped');
        assert.match(sent[0].text, /2 x Widget/);
    }
    const plain = await real.sendInvoiceReady({ to: 'a@b.invalid', order: { order_number: 'CHC-1001' }, companyName: 'Assured' });
    assert.equal(plain.sent, true);
    assert.match(sent.at(-1).subject, /^Invoice ready/);
    assert.doesNotMatch(sent.at(-1).html, /Follow-up/);
});

// ------------------------------------------------------------------
// Closing
// ------------------------------------------------------------------
test('Mark Paid & Close is refused while a follow-up invoice is still owed', async () => {
    reset();
    await upload('invoice', 'first.pdf').send();
    await partial();
    const r = await request(adminApp()).put(`${base()}/close`).send({});
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'followup_invoice_required');
    assert.notEqual(row().status, 'closed');
    assert.notEqual(row().payment_status, 'paid');
});

test('closing from the status dropdown is refused the same way', async () => {
    reset();
    await partial();
    const r = await request(adminApp()).put(`/api/admin/orders/${ORDER}/status`).send({ status: 'closed' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'followup_invoice_required');
    assert.notEqual(row().status, 'closed');
});

test('once the follow-up invoice is uploaded, the order closes', async () => {
    reset();
    await upload('invoice', 'first.pdf').send();
    await partial();
    await upload('followup-invoice', 'second.pdf').send();
    const r = await request(adminApp()).put(`${base()}/close`).send({});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(row().status, 'closed');
    assert.equal(row().followup_invoice_filename, 'second.pdf', 'both invoices stay on the closed order');
});

test('staff can close without one only by saying so, and it is written down', async () => {
    reset();
    await upload('invoice', 'first.pdf').send();
    await partial();
    const r = await request(adminApp()).put(`${base()}/close`).send({ waive_followup: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(row().status, 'closed');
    assert.equal(row().followup_invoice_due, false);
    assert.equal(row().followup_invoice_waived_by, SUPER_ADMIN.id);
    assert.match(row().status_history.at(-1).note, /closed without a follow-up invoice/);
});

test('"follow-up invoice not needed" clears the reminder, records who and why, and needs a reason only if given', async () => {
    reset();
    await upload('invoice', 'first.pdf').send();
    await partial();
    const r = await request(adminApp()).put(`${base()}/followup-invoice/waive`).send({ note: 'Backorder cancelled <b>by shop</b>' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.message, /^Updated/);
    assert.equal(row().followup_invoice_due, false);
    assert.equal(row().followup_invoice_waived_note, 'Backorder cancelled by shop');
    assert.equal(row().followup_invoice_waived_by, SUPER_ADMIN.id);
    assert.match(row().status_history.at(-1).note, /Follow-up invoice not needed: Backorder cancelled by shop/);
    assert.ok(fake.db.audit_log.some(a => a.action === 'followup_invoice_waived'));
    // nothing owed any more: closes normally
    assert.equal((await request(adminApp()).put(`${base()}/close`).send({})).status, 200);
    // and there is nothing left to waive
    reset(); assert.equal((await request(adminApp()).put(`${base()}/followup-invoice/waive`).send({})).status, 409);
});

test('recording a new partial shipment re-opens a waived follow-up', async () => {
    reset();
    await partial();
    await request(adminApp()).put(`${base()}/followup-invoice/waive`).send({});
    await partial([{ product_id: PRODUCT2, quantity: 1 }]);
    assert.equal(row().followup_invoice_due, true);
    assert.equal(row().followup_invoice_waived_at, null);
    assert.equal(row().followup_invoice_items[0].name, 'Sprocket');
});

test('re-recording the backorder after the follow-up was uploaded keeps what the invoice covered', async () => {
    reset();
    await partial([{ product_id: PRODUCT, quantity: 2 }]);
    await upload('followup-invoice', 'second.pdf').send();
    await partial([{ product_id: PRODUCT2, quantity: 1 }]);
    assert.equal(row().followup_invoice_items[0].name, 'Widget');
    assert.equal((await request(adminApp()).put(`${base()}/close`).send({})).status, 200, 'already invoiced: not owed again');
});

// ------------------------------------------------------------------
// Viewing: staff and customer
// ------------------------------------------------------------------
test('staff open the follow-up invoice through a short-lived link; none on file is a 404', async () => {
    reset();
    assert.equal((await request(adminApp()).get(`${base()}/followup-invoice`)).status, 404);
    await upload('followup-invoice', 'second.pdf').send();
    const r = await request(adminApp()).get(`${base()}/followup-invoice`);
    assert.equal(r.status, 200);
    assert.equal(r.body.filename, 'second.pdf');
    assert.match(r.body.url, /followup-invoice-/);
    const first = await request(adminApp()).get(`${base()}/invoice`);
    assert.equal(first.status, 404, 'the first slot is still empty');
});

test('the customer can download both invoices from their own order, and no one else’s', async () => {
    reset();
    await upload('invoice', 'first.pdf').send();
    await upload('followup-invoice', 'second.pdf').send();
    const one = await request(storeApp()).get(`/api/store/assured/orders/${ORDER}/invoice`);
    assert.equal(one.status, 200); assert.equal(one.body.filename, 'first.pdf'); assert.doesNotMatch(one.body.url, /followup/);
    const two = await request(storeApp()).get(`/api/store/assured/orders/${ORDER}/invoice?which=followup`);
    assert.equal(two.status, 200); assert.equal(two.body.filename, 'second.pdf'); assert.match(two.body.url, /followup-invoice-/);
    authCompany = { id: CO_OTHER, name: 'Bayview', slug: 'bayview' };
    assert.equal((await request(storeApp()).get(`/api/store/bayview/orders/${ORDER}/invoice?which=followup`)).status, 404);
});

test('the customer’s follow-up download is 404 until one is uploaded', async () => {
    reset();
    await upload('invoice', 'first.pdf').send();
    assert.equal((await request(storeApp()).get(`/api/store/assured/orders/${ORDER}/invoice?which=followup`)).status, 404);
});

test('the customer’s order history carries the follow-up fields', async () => {
    reset();
    await upload('invoice', 'first.pdf').send();
    await partial();
    const r = await request(storeApp()).get('/api/store/assured/orders');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const o = (r.body.orders || [])[0];
    assert.equal(o.followup_invoice_due, true);
    assert.equal(o.followup_invoice_filename || null, null);
});

// ------------------------------------------------------------------
// Migration and screens
// ------------------------------------------------------------------
test('migration 055: columns, backfill of partial shipments, idempotent, no sign-in changes', () => {
    const fs = require('node:fs');
    const sql = fs.readFileSync(path.join(ROOT, 'migrations/055_followup_invoice.sql'), 'utf8');
    for (const c of ['followup_invoice_due', 'followup_invoice_items', 'followup_invoice_path', 'followup_invoice_filename', 'followup_invoice_uploaded_at', 'followup_invoice_uploaded_by', 'followup_invoice_waived_at'])
        assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${c}\\b`), c);
    assert.match(sql, /WHERE is_partial_shipment = true/i, 'orders partial right now are backfilled');
    assert.ok(!/access_code|individual|activity/i.test(sql.replace(/--.*$/gm, '')), 'no sign-in settings');
    for (const c of Object.keys(require('./helpers/fake-supabase').KNOWN_COLUMNS.orders ? {} : {})) void c;
    const known = require('./helpers/fake-supabase').KNOWN_COLUMNS.orders;
    for (const m of sql.matchAll(/ADD COLUMN IF NOT EXISTS (followup_\w+)/g)) assert.ok(known.has(m[1]), `${m[1]} missing from the test double`);
});

test('console: a "Needs Follow-up Invoice" stage with an upload button, counted under Needs Invoice', () => {
    const fs = require('node:fs');
    const html = fs.readFileSync(path.join(ROOT, 'admin/index.html'), 'utf8');
    assert.match(html, /key: 'need_followup', label: 'Needs Follow-up Invoice'/);
    assert.match(html, /Upload Follow-up Invoice/);
    assert.match(html, /uploadInvoice\('\$\{o\.id\}','\$\{o\.company_id\}', true\)/);
    assert.match(html, /followup-invoice\/waive/);
    assert.match(html, /needsInvoiceStage/);
    assert.match(html, /code === 'followup_invoice_required'/);
    // the first invoice's upload path is unchanged
    assert.match(html, /\$\{followup \? 'followup-invoice' : 'invoice'\}/);
    // the order stage logic, run for real
    const fn = html.slice(html.indexOf('function orderStage(o)'), html.indexOf('// 3-segment mini progress bar'));
    const stage = new Function(fn + '; return { orderStage, followupOwed, needsInvoiceStage };')();
    const base = { status: 'out_on_delivery', invoice_filename: 'a.pdf' };
    assert.equal(stage.orderStage({ status: 'pending' }).key, 'need_invoice');
    assert.equal(stage.orderStage(base).key, 'invoiced');
    assert.equal(stage.orderStage({ ...base, followup_invoice_due: true }).key, 'need_followup');
    assert.equal(stage.orderStage({ ...base, followup_invoice_due: true, followup_invoice_filename: 'b.pdf' }).key, 'invoiced');
    assert.equal(stage.orderStage({ status: 'pending', followup_invoice_due: true }).key, 'need_invoice', 'the first invoice comes first');
    assert.equal(stage.orderStage({ ...base, followup_invoice_due: true, status: 'closed' }).key, 'closed');
    assert.equal(stage.needsInvoiceStage({ ...base, followup_invoice_due: true }), true);
});

test('store page: both download buttons, and a "to follow" note while the second is owed', () => {
    const fs = require('node:fs');
    const html = fs.readFileSync(path.join(ROOT, 'public/store.html'), 'utf8');
    assert.match(html, /Download Backorder Invoice/);
    assert.match(html, /Backorder invoice to follow/);
    assert.match(html, /\?which=followup/);
});
