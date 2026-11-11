/**
 * tests/qa-regressions.test.js
 *
 * Defects found by the full end-to-end QA run in a throw-away company:
 * admin adjust ignoring allow_negative, short barcodes being zero-padded past the
 * length check, receiving against a pending order, and the shop inventory
 * history CSV export referencing a function that was never in scope.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { createFakeSupabase } = require('./helpers/fake-supabase');

// ------------------------------------------------------------------
// Stubs, installed before the routes are required.
// ------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '..');
let fake = createFakeSupabase();
let authCompany = null;

const supabaseProxy = new Proxy({}, {
    get: (_t, prop) => {
        const v = fake[prop];
        return typeof v === 'function' ? v.bind(fake) : v;
    }
});

const stubs = {
    [path.join(ROOT, 'utils/supabase.js')]: { supabaseAdmin: supabaseProxy },
    [path.join(ROOT, 'middleware/auth.js')]: {
        requireCompanyAuth: (req, res, next) => {
            if (!authCompany) return res.status(401).json({ error: 'Not authenticated.' });
            req.company = authCompany;
            next();
        },
        requireAdminAuth: (req, res, next) => next(),
        requireSuperAdmin: (req, res, next) => next(),
        requireCompanyAccess: (req, res, next) => next()
    },
    [path.join(ROOT, 'utils/sanitize.js')]: {
        stripHtml: (s) => String(s === undefined || s === null ? '' : s).replace(/<[^>]*>/g, ''),
        sanitizeObject: (o) => o,
        isValidUUID: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '')),
        generateSlug: (s) => s,
        validateEmail: () => true
    },
    [path.join(ROOT, 'utils/recipients.js')]: {
        resolveOrderRecipients: async () => ({ to: ['branch@chcpaint.com'], replyTo: 'shop@example.com' }),
        validEmails: (list) => list
    },
    [path.join(ROOT, 'utils/email.js')]: {
        sendOrderNotification: async () => {},
        sendInvoiceReady: async () => {},
        sendOrderClosed: async () => {},
        sendLowStockAlert: async () => ({ ok: true })
    },
    [path.join(ROOT, 'utils/inventory-alerts.js')]: {
        notifyReorderRaised: async () => {}
    },
    [path.join(ROOT, 'middleware/upload.js')]: {
        catalogUpload: { single: () => (req, res, next) => next() },
        logoUpload: { single: () => (req, res, next) => next() },
        invoiceUpload: { single: () => (req, res, next) => next() }
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
const { inventorySettings, INVENTORY_FEATURES } = require('../utils/inventory');
const adminInventory = require('../routes/inventory-admin');

const inventoryStore = require('../routes/inventory-store');

const CO  = '11111111-1111-4111-8111-111111111111';
const LOC = '33333333-3333-4333-8333-333333333333';
const P1  = '55555555-5555-4555-8555-555555555555';

function seed(settings = {}) {
    fake = createFakeSupabase({
        companies: [{ id: CO, name: 'Concord Collision', slug: 'concord', settings: { inventory: { enabled: true, ...settings } } }],
        company_locations: [{ id: LOC, company_id: CO, name: 'Main', is_active: true, restrict_to_category: null }],
        products: [{ id: P1, company_id: CO, sku: 'PRF611N', name: 'ProForm Clear Ga', category: 'Paint', price: 200, is_active: true }],
        inventory_levels: [{ id: 'l1', company_id: CO, location_id: LOC, product_id: P1, on_hand: 3, is_tracked: true }],
        audit_log: []
    });
    authCompany = { id: CO, name: 'Concord Collision', slug: 'concord' };
}
function adminApp() {
    const a = express(); a.use(express.json());
    a.use((req, res, next) => { req.admin = { id: 'admin-1', role: 'super_admin', email: 'qa@example.invalid' }; next(); });
    a.use('/api/admin/companies/:companyId/inventory', adminInventory);
    return a;
}
function storeApp() { const a = express(); a.use(express.json()); a.use('/api/store/:slug/inventory', inventoryStore); return a; }
const A = `/api/admin/companies/${CO}/inventory`;
const onHand = () => Number(fake.db.inventory_levels.find(l => l.product_id === P1).on_hand);

// ---- admin adjust honours allow_negative (shop screens already did) ----------
test('admin adjustment cannot take stock below zero when negative stock is not allowed', async () => {
    seed({ allow_negative: false });
    const res = await request(adminApp()).post(`${A}/adjust`)
        .send({ location_id: LOC, product_id: P1, movement_type: 'adjust', quantity: -10, reason: 'QA' });
    assert.ok([400, 409].includes(res.status), JSON.stringify(res.body));
    assert.equal(onHand(), 3, 'stock must be unchanged');
});

test('admin adjustment may go negative when the company allows it', async () => {
    seed({ allow_negative: true });
    const res = await request(adminApp()).post(`${A}/adjust`)
        .send({ location_id: LOC, product_id: P1, movement_type: 'adjust', quantity: -10, reason: 'QA' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(onHand(), -7);
});

test('a normal admin adjustment still works', async () => {
    seed({});
    const res = await request(adminApp()).post(`${A}/adjust`)
        .send({ location_id: LOC, product_id: P1, movement_type: 'adjust', quantity: -2, reason: 'QA' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(onHand(), 1);
});

// ---- barcode length is judged on what was typed ------------------------------
test('a 2-digit barcode is refused (it used to be zero-padded to 13 digits and accepted)', async () => {
    seed({});
    const res = await request(adminApp()).post(`${A}/barcodes`).send({ product_id: P1, barcode: '12' });
    assert.equal(res.status, 400, JSON.stringify(res.body));
});

test('a normal UPC barcode is still accepted', async () => {
    seed({});
    const res = await request(adminApp()).post(`${A}/barcodes`).send({ product_id: P1, barcode: '012345678905' });
    assert.ok([200, 201].includes(res.status), JSON.stringify(res.body));
});

// ---- receiving against an order CHC has not processed ------------------------
test('lines cannot be received against a pending order', async () => {
    seed({});
    const { data: order } = await fake.from('orders').insert({
        company_id: CO, order_number: 'CHC-1', company_name: 'x', contact_name: 'x', contact_email: 'x@example.invalid',
        location_id: LOC, status: 'pending', subtotal: 200, tax: 26, total: 226,
        items: [{ product_id: P1, sku: 'PRF611N', name: 'ProForm Clear Ga', quantity: 2, unit_price: 200 }]
    }).select().single();
    const res = await request(storeApp()).post(`/api/store/concord/inventory/receiving/orders/${order.id}/lines`)
        .send({ location_id: LOC, actor_label: 'Sam', receipts: [{ product_id: P1, quantity: 2 }] });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(onHand(), 3, 'nothing may be added to stock');
});

// ---- the shop CSV export used a function that did not exist -----------------
test('inventory history export calls RAI.csvCell, and exports numbers untouched', () => {
    const fs = require('node:fs');
    const js = fs.readFileSync(path.join(ROOT, 'public/refinishai-inventory.js'), 'utf8');
    assert.ok(!/map\(csvCell\)/.test(js), 'bare csvCell reference would throw ReferenceError in the browser');
    assert.ok(/typeof v !== 'number'/.test(js), 'negative quantities must not be prefixed with an apostrophe');
});
