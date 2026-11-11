/**
 * tests/inventory-features.test.js
 *
 * The per-company switches for the parts of Inventory (settings.inventory.features):
 * defaults keep every existing company unchanged, an explicit false turns one
 * off, and the admin settings route only ever stores known names with boolean
 * values.
 *
 *   node --test tests/
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

const CO = '11111111-1111-4111-8111-111111111111';

test('every part is on when a company has no features block (nothing changes for existing companies)', () => {
    const s = inventorySettings({ inventory: { enabled: true } });
    for (const f of INVENTORY_FEATURES) assert.equal(s.features[f], true, f);
    assert.deepEqual(Object.keys(s.features).sort(), [...INVENTORY_FEATURES].sort());
});

test('only an explicit false switches a part off', () => {
    const s = inventorySettings({ inventory: { enabled: true, features: { counts: false, transfers: 0, labels: null, receiving: 'no' } } });
    assert.equal(s.features.counts, false);
    assert.equal(s.features.transfers, true);
    assert.equal(s.features.labels, true);
    assert.equal(s.features.receiving, true);
});

function adminApp() {
    const a = express();
    a.use(express.json());
    a.use((req, res, next) => { req.admin = { id: 'admin-1', role: 'super_admin' }; next(); });
    a.use('/api/admin/companies/:companyId/inventory', adminInventory);
    return a;
}

function seed(settings) {
    fake = createFakeSupabase({
        companies: [{ id: CO, name: 'Concord Collision', slug: 'concord', settings }],
        company_locations: [], inventory_levels: [], audit_log: []
    });
}

test('the admin route stores a switched-off part and keeps every other setting', async () => {
    seed({ inventory: { enabled: true, auto_draft: true, require_approval: true, alert_emails: ['a@b.com'] }, users: { enabled: true } });
    const res = await request(adminApp()).put(`/api/admin/companies/${CO}/inventory/settings`).send({ features: { transfers: false } });
    assert.equal(res.status, 200);
    assert.equal(res.body.settings.features.transfers, false);
    assert.equal(res.body.settings.features.counts, true);
    const stored = fake.db.companies[0].settings;
    assert.equal(stored.inventory.features.transfers, false);
    assert.equal(stored.inventory.auto_draft, true);
    assert.deepEqual(stored.inventory.alert_emails, ['a@b.com']);
    assert.deepEqual(stored.users, { enabled: true }, 'other modules must be untouched');
});

test('the admin route ignores unknown part names and non-boolean values', async () => {
    seed({ inventory: { enabled: true } });
    const res = await request(adminApp()).put(`/api/admin/companies/${CO}/inventory/settings`)
        .send({ features: { counts: 'false', evil: false, labels: false } });
    assert.equal(res.status, 200);
    const f = fake.db.companies[0].settings.inventory.features;
    assert.equal(f.counts, true, 'a string is not a boolean');
    assert.equal(f.labels, false);
    assert.equal('evil' in f, false);
});

test('a switched-off part can be switched back on, and a plain save never turns one off', async () => {
    seed({ inventory: { enabled: true, features: { counts: false } } });
    await request(adminApp()).put(`/api/admin/companies/${CO}/inventory/settings`).send({ scan_sound: false });
    assert.equal(fake.db.companies[0].settings.inventory.features.counts, false, 'unrelated save keeps it off');
    await request(adminApp()).put(`/api/admin/companies/${CO}/inventory/settings`).send({ features: { counts: true } });
    assert.equal(fake.db.companies[0].settings.inventory.features.counts, true);
});
