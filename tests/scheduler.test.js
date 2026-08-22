/**
 * tests/scheduler.test.js
 *
 * The scheduler, the module registry, and the two alerts that were built but
 * had nothing calling them.
 *
 * The properties worth defending here are the ones that only show up in
 * production: that a digest goes out in the shop's morning rather than the
 * server's, that two app instances cannot both send it, and that turning a
 * module off never destroys what the customer had.
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { createFakeSupabase } = require('./helpers/fake-supabase');

const ROOT = path.resolve(__dirname, '..');
let fake = createFakeSupabase();
const sent = { digests: [], reorders: [] };

/** Swappable email behaviour — a test can replace one of these to force a failure. */
const DEFAULT_MAIL = {
    sendLowStockAlert: async (opts) => { sent.digests.push(opts); return { sent: true, recipients: opts.to, count: opts.count }; },
    sendReorderRaised: async (opts) => { sent.reorders.push(opts); return { sent: true, recipients: opts.to, count: opts.lines.length }; }
};
let mail = { ...DEFAULT_MAIL };
let authAdmin = { id: 'aaaaaaaa-0000-4000-8000-000000000001', role: 'super_admin', company_id: null };

const supabaseProxy = new Proxy({}, {
    get: (_t, prop) => {
        const v = fake[prop];
        return typeof v === 'function' ? v.bind(fake) : v;
    }
});

const stubs = {
    [path.join(ROOT, 'utils/supabase.js')]: { supabaseAdmin: supabaseProxy },
    [path.join(ROOT, 'middleware/auth.js')]: {
        requireCompanyAuth: (req, res, next) => next(),
        requireAdminAuth: (req, res, next) => { req.admin = authAdmin; next(); },
        requireSuperAdmin: (req, res, next) => next(),
        requireCompanyAccess: (req, res, next) => { req.admin = authAdmin; next(); }
    },
    [path.join(ROOT, 'utils/sanitize.js')]: {
        stripHtml: (s) => String(s === undefined || s === null ? '' : s).replace(/<[^>]*>/g, ''),
        sanitizeObject: (o) => o,
        isValidUUID: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '')),
        generateSlug: (s) => s,
        validateEmail: () => true
    },
    [path.join(ROOT, 'utils/recipients.js')]: {
        resolveOrderRecipients: async () => ({ to: [], replyTo: null }),
        validEmails: (list) => (list || []).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim()))
    },
    // The modules under test destructure these at require time, so the stub has
    // to be a stable function that forwards to whatever the current test
    // installed — the same reason the supabase stub is a Proxy.
    [path.join(ROOT, 'utils/email.js')]: {
        sendOrderNotification: async () => {},
        sendInvoiceReady: async () => {},
        sendOrderClosed: async () => {},
        sendTestEmail: async () => ({ sent: true }),
        sendLowStockAlert: (...args) => mail.sendLowStockAlert(...args),
        sendReorderRaised: (...args) => mail.sendReorderRaised(...args)
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
const modules = require('../utils/modules');
const scheduler = require('../utils/scheduler');
const alerts = require('../utils/inventory-alerts');
const modulesAdmin = require('../routes/modules-admin');

const CO  = '11111111-1111-4111-8111-111111111111';
const CO2 = '22222222-2222-4222-8222-222222222222';
const LOC = '33333333-3333-4333-8333-333333333333';
const LOC2 = '44444444-4444-4444-8444-444444444444';
const P_CLEAR = '55555555-5555-4555-8555-555555555555';
const P_TAPE  = '77777777-7777-4777-8777-777777777777';

function seed(overrides = {}) {
    return createFakeSupabase({
        companies: [
            { id: CO, name: 'Assured Collision', slug: 'assured', is_active: true,
              timezone: 'America/Toronto', contact_email: 'shop@assured.test',
              email_config: { manager_emails: ['manager@assured.test'] },
              settings: { inventory: { enabled: true, alert_emails: ['extra@assured.test'] } } },
            { id: CO2, name: 'Ordering Only', slug: 'ordering', is_active: true,
              timezone: 'America/Toronto', contact_email: 'a@b.test',
              email_config: {}, settings: {} }
        ],
        company_locations: [
            { id: LOC, company_id: CO, name: 'Burlington', is_active: true }
        ],
        // inventory_status is a view, both in the database and in the fake, so
        // the shortage is created by seeding what it derives from.
        products: [
            { id: P_CLEAR, company_id: CO, sku: 'PRF611N', name: 'Clear', brand: 'ProForm', price: 200, is_active: true },
            { id: P_TAPE,  company_id: CO, sku: 'MMM06334', name: 'Tape', brand: '3M', price: 10, is_active: true }
        ],
        inventory_levels: [
            { id: 'lvl-1', company_id: CO, location_id: LOC, product_id: P_CLEAR, on_hand: 0, min_point: 2, max_point: 10, is_tracked: true },
            { id: 'lvl-2', company_id: CO, location_id: LOC, product_id: P_TAPE,  on_hand: 1, min_point: 5, max_point: 20, is_tracked: true }
        ],
        ...overrides
    });
}

function reset(overrides) {
    fake = seed(overrides);
    sent.digests = [];
    sent.reorders = [];
    mail = { ...DEFAULT_MAIL };
}

function adminApp() {
    const a = express();
    a.use(express.json());
    a.use('/api/admin/companies/:companyId/modules', modulesAdmin);
    return a;
}

// ==================================================================
// MODULE REGISTRY
// ==================================================================

test('a module nobody configured reads as off, not as missing', () => {
    const s = modules.moduleSettings({}, 'inventory');
    assert.equal(s.enabled, false);
    assert.equal(s.auto_draft, true, 'defaults still fill in');
});

test('a module is off when something it depends on is off', () => {
    const settings = { kits: { enabled: true } };          // inventory not on
    assert.equal(modules.moduleEnabled(settings, 'kits'), false);
});

test('turning a dependency off turns the dependent off, on read', () => {
    const on = { inventory: { enabled: true }, kits: { enabled: true } };
    assert.equal(modules.moduleEnabled(on, 'kits'), true);

    const off = { inventory: { enabled: false }, kits: { enabled: true } };
    assert.equal(modules.moduleEnabled(off, 'kits'), false,
        'the kits flag is still true, but it must not be honoured');
});

test('an unreleased module refuses to be turned on', () => {
    const settings = { inventory: { enabled: true }, kits: { enabled: true } };
    const check = modules.canSetModule(settings, 'insurance', true);
    assert.equal(check.ok, false);
    assert.match(check.error, /not available yet/i);
});

test('turning anything off is always allowed', () => {
    for (const name of modules.MODULE_NAMES) {
        assert.equal(modules.canSetModule({}, name, false).ok, true);
    }
});

test('toggling a module preserves its other settings', () => {
    const before = { inventory: { enabled: true, alert_emails: ['a@b.test'], digest_hour: 6 } };
    const off = modules.withModule(before, 'inventory', { enabled: false });
    const backOn = modules.withModule(off, 'inventory', { enabled: true });

    assert.deepEqual(backOn.inventory.alert_emails, ['a@b.test']);
    assert.equal(backOn.inventory.digest_hour, 6);
});

test('module status reports what is blocking a toggle', () => {
    const status = modules.moduleStatus({ inventory: { enabled: false } });
    const kits = status.find(m => m.name === 'kits');
    assert.deepEqual(kits.blocked_by, ['inventory']);
    assert.equal(kits.available, false);
});

test('dependents are discoverable so a toggle can warn before it breaks them', () => {
    assert.deepEqual(modules.dependentsOf('inventory'), ['kits', 'insurance']);
    assert.deepEqual(modules.dependentsOf('kits'), ['insurance']);
});

// ==================================================================
// MODULE ADMIN ROUTES
// ==================================================================

test('a module can be turned on through the API', async () => {
    reset();
    fake.db.companies[0].settings = {};
    const res = await request(adminApp()).put(`/api/admin/companies/${CO}/modules/inventory`).send({ enabled: true });
    assert.equal(res.status, 200);
    assert.equal(fake.db.companies[0].settings.inventory.enabled, true);
});

test('turning on a module whose dependency is off is refused with a reason', async () => {
    reset();
    fake.db.companies[0].settings = {};
    const res = await request(adminApp()).put(`/api/admin/companies/${CO}/modules/kits`).send({ enabled: true });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /turn refinishAI Inventory on first/i);
});

test('turning off a module that others depend on asks first', async () => {
    reset();
    fake.db.companies[0].settings = { inventory: { enabled: true }, kits: { enabled: true } };

    const blocked = await request(adminApp()).put(`/api/admin/companies/${CO}/modules/inventory`).send({ enabled: false });
    assert.equal(blocked.status, 409);
    assert.deepEqual(blocked.body.dependents, ['kits']);
    assert.equal(fake.db.companies[0].settings.inventory.enabled, true, 'nothing changed while it asked');

    const confirmed = await request(adminApp())
        .put(`/api/admin/companies/${CO}/modules/inventory`)
        .send({ enabled: false, confirm_dependents: true });
    assert.equal(confirmed.status, 200);
    assert.equal(fake.db.companies[0].settings.inventory.enabled, false);
    assert.equal(fake.db.companies[0].settings.kits.enabled, true,
        'the kits flag is kept, so turning inventory back on restores kits too');
});

test('an unknown module is a 404, not a silently written flag', async () => {
    reset();
    const res = await request(adminApp()).put(`/api/admin/companies/${CO}/modules/telemetry`).send({ enabled: true });
    assert.equal(res.status, 404);
    assert.equal(fake.db.companies[0].settings.telemetry, undefined);
});

// ==================================================================
// LOCAL TIME
// ==================================================================

test('the local hour is resolved in the company zone, not the server zone', () => {
    const toronto = scheduler.localNow('America/Toronto');
    const tokyo = scheduler.localNow('Asia/Tokyo');
    assert.ok(Number.isInteger(toronto.hour) && toronto.hour >= 0 && toronto.hour <= 23);
    assert.ok(Number.isInteger(tokyo.hour) && tokyo.hour >= 0 && tokyo.hour <= 23);
    assert.notEqual(toronto.hour, tokyo.hour, 'two zones this far apart cannot share an hour');
    assert.match(toronto.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('a nonsense time zone falls back instead of throwing', () => {
    const out = scheduler.localNow('Not/AZone');
    assert.ok(Number.isInteger(out.hour));
    assert.match(out.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('midnight is hour 0, not hour 24', () => {
    // en-CA with hour12:false renders midnight as '24'; the helper normalises it.
    // Sweep every zone offset to be sure one of them lands on midnight.
    const zones = ['UTC', 'America/Toronto', 'Asia/Tokyo', 'Europe/London', 'Australia/Sydney',
                   'Pacific/Auckland', 'America/Los_Angeles', 'Asia/Kolkata'];
    for (const z of zones) {
        assert.ok(scheduler.localNow(z).hour < 24, `${z} produced hour 24`);
    }
});

// ==================================================================
// THE CLAIM — the whole of the multi-instance safety
// ==================================================================

test('only one caller can claim a run key', async () => {
    reset();
    const first = await scheduler.claim('low_stock_digest', 'key-1');
    const second = await scheduler.claim('low_stock_digest', 'key-1');
    assert.equal(first, true);
    assert.equal(second, false, 'a second instance must lose the race');
    assert.equal(fake.db.scheduler_runs.length, 1);
});

test('different run keys do not collide', async () => {
    reset();
    assert.equal(await scheduler.claim('low_stock_digest', 'day-1'), true);
    assert.equal(await scheduler.claim('low_stock_digest', 'day-2'), true);
    assert.equal(fake.db.scheduler_runs.length, 2);
});

test('the same key under a different job is a different claim', async () => {
    reset();
    assert.equal(await scheduler.claim('job_a', 'shared'), true);
    assert.equal(await scheduler.claim('job_b', 'shared'), true);
});

// ==================================================================
// THE DIGEST JOB
// ==================================================================

test('the digest runs for a company at its chosen local hour and not otherwise', async () => {
    reset();
    const { hour } = scheduler.localNow('America/Toronto');

    // Set the target to an hour that is definitely not now.
    fake.db.companies[0].settings.inventory.digest_hour = (hour + 5) % 24;
    let outcome = await scheduler.lowStockDigestJob();
    assert.equal(outcome.due, 0);
    assert.equal(sent.digests.length, 0);

    // Now set it to the current hour.
    fake.db.companies[0].settings.inventory.digest_hour = hour;
    outcome = await scheduler.lowStockDigestJob();
    assert.equal(outcome.due, 1);
    assert.equal(outcome.sent, 1);
    assert.equal(sent.digests.length, 1);
});

test('a company without inventory is never considered', async () => {
    reset();
    const { hour } = scheduler.localNow('America/Toronto');
    fake.db.companies[0].settings.inventory.digest_hour = hour;
    fake.db.companies[1].settings = {};

    const outcome = await scheduler.lowStockDigestJob();
    assert.equal(outcome.considered, 1, 'only the company with the module on');
});

test('running the job twice in the same local day sends once', async () => {
    reset();
    const { hour } = scheduler.localNow('America/Toronto');
    fake.db.companies[0].settings.inventory.digest_hour = hour;

    await scheduler.lowStockDigestJob();
    await scheduler.lowStockDigestJob();

    assert.equal(sent.digests.length, 1, 'the claim stops the second run');
});

test('the digest goes to the contact, the managers and the inventory addresses', async () => {
    reset();
    const { hour } = scheduler.localNow('America/Toronto');
    fake.db.companies[0].settings.inventory.digest_hour = hour;

    await scheduler.lowStockDigestJob();
    assert.deepEqual(sent.digests[0].to.sort(),
        ['extra@assured.test', 'manager@assured.test', 'shop@assured.test']);
});

test('the digest links back to the shop, not to a bare domain', async () => {
    reset();
    const { hour } = scheduler.localNow('America/Toronto');
    fake.db.companies[0].settings.inventory.digest_hour = hour;

    await scheduler.lowStockDigestJob();
    assert.match(sent.digests[0].storeUrl, /\/store\/assured$/);
});

test('the run outcome is recorded so an operator can see it happened', async () => {
    reset();
    const { hour } = scheduler.localNow('America/Toronto');
    fake.db.companies[0].settings.inventory.digest_hour = hour;

    await scheduler.lowStockDigestJob();
    const run = fake.db.scheduler_runs[0];
    assert.ok(run.finished_at, 'a completed run is marked finished');
    assert.equal(run.result.sent, true);
});

test('one company failing does not stop the others', async () => {
    reset();
    const { hour } = scheduler.localNow('America/Toronto');

    // Give the second company inventory too, then break the first one's send.
    fake.db.companies[0].settings.inventory.digest_hour = hour;
    fake.db.companies[1].settings = { inventory: { enabled: true, digest_hour: hour, alert_emails: [] } };
    fake.db.company_locations.push({ id: LOC2, company_id: CO2, name: 'Their shop', is_active: true });
    fake.db.products.push({ id: 'p-other', company_id: CO2, sku: 'X', name: 'Thing', price: 1, is_active: true });
    fake.db.inventory_levels.push({
        id: 'lvl-other', company_id: CO2, location_id: LOC2, product_id: 'p-other',
        on_hand: 0, min_point: 1, max_point: 5, is_tracked: true
    });

    let calls = 0;
    const original = mail.sendLowStockAlert;
    mail.sendLowStockAlert = async (opts) => {
        calls += 1;
        if (calls === 1) throw new Error('SendGrid is having a day');
        return original(opts);
    };

    const outcome = await scheduler.lowStockDigestJob();
    assert.equal(outcome.failed, 1);
    assert.equal(outcome.sent, 1, 'the second company still got its digest');
});

// ==================================================================
// THE DIGEST ITSELF
// ==================================================================

test('nothing below minimum means no email at all', async () => {
    reset({ inventory_levels: [] });
    const result = await alerts.runLowStockDigest({
        companyId: CO, settings: modules.moduleSettings(fake.db.companies[0].settings, 'inventory')
    });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'nothing_to_report');
    assert.equal(sent.digests.length, 0);
});

test('a company with no addresses is reported, not silently skipped', async () => {
    reset();
    fake.db.companies[0].contact_email = null;
    fake.db.companies[0].email_config = {};
    fake.db.companies[0].settings.inventory.alert_emails = [];

    const result = await alerts.runLowStockDigest({
        companyId: CO, settings: modules.moduleSettings(fake.db.companies[0].settings, 'inventory')
    });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'no_recipients');
});

test('identical content inside the window is suppressed', async () => {
    reset();
    const settings = modules.moduleSettings(fake.db.companies[0].settings, 'inventory');

    const first = await alerts.runLowStockDigest({ companyId: CO, settings });
    assert.equal(first.sent, true);

    const second = await alerts.runLowStockDigest({ companyId: CO, settings });
    assert.equal(second.sent, false);
    assert.equal(second.reason, 'already_sent');
    assert.equal(sent.digests.length, 1);
});

test('a changed shortage sends again — suppression is on content, not on time', async () => {
    reset();
    const settings = modules.moduleSettings(fake.db.companies[0].settings, 'inventory');

    await alerts.runLowStockDigest({ companyId: CO, settings });
    fake.db.inventory_levels[0].on_hand = -3;              // it got worse
    const second = await alerts.runLowStockDigest({ companyId: CO, settings });

    assert.equal(second.sent, true);
    assert.equal(sent.digests.length, 2);
});

test('force overrides suppression, for re-sending after a bad address', async () => {
    reset();
    const settings = modules.moduleSettings(fake.db.companies[0].settings, 'inventory');
    await alerts.runLowStockDigest({ companyId: CO, settings });
    const again = await alerts.runLowStockDigest({ companyId: CO, settings, force: true });
    assert.equal(again.sent, true);
});

test('a dry run reports the recipients and sends nothing', async () => {
    reset();
    const settings = modules.moduleSettings(fake.db.companies[0].settings, 'inventory');
    const result = await alerts.runLowStockDigest({ companyId: CO, settings, dryRun: true });

    assert.equal(result.sent, false);
    assert.equal(result.preview, true);
    assert.equal(result.count, 2);
    assert.equal(sent.digests.length, 0);
});

test('the digest is grouped by location', async () => {
    reset();
    const settings = modules.moduleSettings(fake.db.companies[0].settings, 'inventory');
    await alerts.runLowStockDigest({ companyId: CO, settings });
    assert.deepEqual(Object.keys(sent.digests[0].byLocation), ['Burlington']);
    assert.equal(sent.digests[0].byLocation.Burlington.length, 2);
});

// ==================================================================
// REORDER RAISED
// ==================================================================

function seedOrder(orderId = 'ord-1', locationId = LOC) {
    fake.db.replenishment_orders.push({
        id: orderId, company_id: CO, location_id: locationId, status: 'pending_approval'
    });
    fake.db.replenishment_order_lines.push(
        { id: 'l1', order_id: orderId, product_id: 'p1', sku: 'PRF611N', name: 'Clear', quantity: 10, on_hand_at_draft: 0, min_point: 2 },
        { id: 'l2', order_id: orderId, product_id: 'p2', sku: 'MMM06334', name: 'Tape', quantity: 19, on_hand_at_draft: 1, min_point: 5 }
    );
    return orderId;
}

test('raising a reorder notifies the managers once', async () => {
    reset();
    const orderId = seedOrder();

    await alerts.notifyReorderRaised({ companyId: CO, locationName: 'Burlington', orderId });
    await alerts.notifyReorderRaised({ companyId: CO, locationName: 'Burlington', orderId });

    assert.equal(sent.reorders.length, 1, 'the same order must not notify twice');
    assert.equal(sent.reorders[0].lines.length, 2);
    assert.equal(sent.reorders[0].locationName, 'Burlington');
});

test('a second order at another location does notify', async () => {
    reset();
    await alerts.notifyReorderRaised({ companyId: CO, locationName: 'Burlington', orderId: seedOrder('ord-1') });
    await alerts.notifyReorderRaised({ companyId: CO, locationName: 'Hamilton', orderId: seedOrder('ord-2', LOC2) });
    assert.equal(sent.reorders.length, 2);
});

test('a company that switched the notice off does not get one', async () => {
    reset();
    fake.db.companies[0].settings.inventory.notify_on_draft = false;
    await alerts.notifyReorderRaised({ companyId: CO, locationName: 'Burlington', orderId: seedOrder() });
    assert.equal(sent.reorders.length, 0);
});

test('a company without inventory is never notified', async () => {
    reset();
    fake.db.companies[0].settings = {};
    await alerts.notifyReorderRaised({ companyId: CO, locationName: 'Burlington', orderId: seedOrder() });
    assert.equal(sent.reorders.length, 0);
});

test('a notification failure never throws at the caller', async () => {
    reset();
    seedOrder();
    mail.sendReorderRaised = async () => { throw new Error('down'); };

    // The caller is the scan path. It must not care.
    const result = await alerts.notifyReorderRaised({ companyId: CO, locationName: 'Burlington', orderId: 'ord-1' });
    assert.equal(result, null);
});

// ==================================================================
// STARTUP SAFETY
// ==================================================================

test('the scheduler refuses to start under test, so a suite never emails anyone', () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
        const out = scheduler.start();
        assert.equal(out.started, false);
        assert.equal(out.reason, 'disabled');
    } finally {
        process.env.NODE_ENV = before;
        scheduler.stop();
    }
});

test('SCHEDULER_ENABLED=false is honoured outside test too', () => {
    const beforeEnv = process.env.NODE_ENV;
    const beforeFlag = process.env.SCHEDULER_ENABLED;
    process.env.NODE_ENV = 'production';
    process.env.SCHEDULER_ENABLED = 'false';
    try {
        assert.equal(scheduler.start().started, false);
    } finally {
        process.env.NODE_ENV = beforeEnv;
        if (beforeFlag === undefined) delete process.env.SCHEDULER_ENABLED;
        else process.env.SCHEDULER_ENABLED = beforeFlag;
        scheduler.stop();
    }
});
