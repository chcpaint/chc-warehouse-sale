/**
 * tests/dashboard.test.js
 *
 * The console dashboard. Every number on that screen is one somebody will
 * quote in a meeting, so the tests here are mostly about the ways a total can
 * be wrong while still looking plausible:
 *
 *   - a cancelled order counted as revenue
 *   - a price-on-request line counted as $0 instead of "not priced"
 *   - a customer vanishing from the table because they bought nothing
 *   - a company admin seeing another shop's sales
 *   - a read stopping at 1000 rows and reporting a smaller business
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
let authAdmin = { id: 'admin-1', role: 'super_admin', company_id: null };

const supabaseProxy = new Proxy({}, {
    get: (_t, prop) => {
        const v = fake[prop];
        return typeof v === 'function' ? v.bind(fake) : v;
    }
});

const stubs = {
    [path.join(ROOT, 'utils/supabase.js')]: { supabaseAdmin: supabaseProxy },
    [path.join(ROOT, 'utils/sanitize.js')]: {
        stripHtml: s => String(s ?? ''),
        sanitizeObject: o => o,
        isValidUUID: v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '')),
        generateSlug: s => s,
        validateEmail: () => true
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
const dashboard = require('../routes/admin-dashboard');
// The real fence, unstubbed. The point of importing it here is to prove the
// dashboard is behind it, not to mock it away.
const { restrictOrderDesk } = require('../middleware/auth');

// ------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------
const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const CO_C = '33333333-3333-4333-8333-333333333333';   // a customer with no activity
const LOC_A = '44444444-4444-4444-8444-444444444444';

const CLEAR = 'aaaaaaa1-1111-4111-8111-111111111111';
const TAPE  = 'aaaaaaa2-2222-4222-8222-222222222222';
const RENTAL = 'aaaaaaa3-3333-4333-8333-333333333333'; // price on request
const RETIRED = 'aaaaaaa4-4444-4444-8444-444444444444'; // inactive product

// Dates chosen so "this year" and a narrow custom window disagree, which is
// what makes the period test mean anything.
const NOW = new Date();
const thisYear = NOW.getFullYear();
const iso = (y, m, d) => new Date(y, m, d, 12, 0, 0).toISOString();
const RECENT = iso(thisYear, NOW.getMonth(), Math.min(NOW.getDate(), 28));
const LAST_YEAR = iso(thisYear - 1, 5, 15);

function line(sku, name, qty, price) {
    return { product_id: sku, sku, name, quantity: qty, unit_price: price };
}

function seed(extra = {}) {
    return createFakeSupabase({
        companies: [
            { id: CO_A, name: 'Assured Collision', slug: 'assured', is_active: true, settings: {} },
            { id: CO_B, name: 'Bayview Auto Body', slug: 'bayview', is_active: true, settings: {} },
            { id: CO_C, name: 'Quiet Shop', slug: 'quiet', is_active: true, settings: {} }
        ],
        company_locations: [
            { id: LOC_A, company_id: CO_A, name: 'Burlington', is_active: true }
        ],
        products: [
            { id: CLEAR,   company_id: CO_A, sku: 'PRF611N',  name: 'ProForm Clear', price: 200, is_active: true, price_on_request: false },
            { id: TAPE,    company_id: CO_A, sku: 'MMM06334', name: 'Masking Tape',  price: 10,  is_active: true, price_on_request: false },
            { id: RENTAL,  company_id: CO_A, sku: 'BOOTH-1',  name: 'Booth',         price: 0,   is_active: true, price_on_request: true },
            { id: RETIRED, company_id: CO_A, sku: 'OLD-1',    name: 'Discontinued',  price: 500, is_active: false, price_on_request: false }
        ],
        orders: [
            // A: two real orders. Clear is expensive per unit, tape is bought
            // in volume — so the two "top products" lists must not match.
            { id: 'o1', company_id: CO_A, order_number: 'A-1', status: 'closed', total: 2100, created_at: RECENT,
              items: [line('PRF611N', 'ProForm Clear', 10, 200), line('MMM06334', 'Masking Tape', 10, 10)] },
            { id: 'o2', company_id: CO_A, order_number: 'A-2', status: 'pending', total: 400, created_at: RECENT,
              items: [line('MMM06334', 'Masking Tape', 40, 10)] },
            // B: one real order plus one cancelled one that must not count.
            { id: 'o3', company_id: CO_B, order_number: 'B-1', status: 'delivered', total: 600, created_at: RECENT,
              items: [line('PRF611N', 'ProForm Clear', 3, 200)] },
            { id: 'o4', company_id: CO_B, order_number: 'B-2', status: 'cancelled', total: 99999, created_at: RECENT,
              items: [line('PRF611N', 'ProForm Clear', 500, 200)] },
            // A quoted line: real units, no price. Order total reflects only
            // what could be priced.
            { id: 'o5', company_id: CO_A, order_number: 'A-3', status: 'pending', total: 0, created_at: RECENT,
              items: [{ product_id: 'BOOTH-1', sku: 'BOOTH-1', name: 'Booth', quantity: 2, unit_price: null, price_on_request: true }] },
            // Last year — out of range for every period but "this year"'s
            // neighbours and "all".
            { id: 'o6', company_id: CO_A, order_number: 'A-OLD', status: 'closed', total: 5000, created_at: LAST_YEAR,
              items: [line('PRF611N', 'ProForm Clear', 25, 200)] }
        ],
        inventory_levels: [
            { id: 'il1', company_id: CO_A, location_id: LOC_A, product_id: CLEAR,   on_hand: 6 },
            { id: 'il2', company_id: CO_A, location_id: LOC_A, product_id: TAPE,    on_hand: 100 },
            { id: 'il3', company_id: CO_A, location_id: LOC_A, product_id: RENTAL,  on_hand: 3 },   // no price
            { id: 'il4', company_id: CO_A, location_id: LOC_A, product_id: RETIRED, on_hand: 9 },   // inactive
            { id: 'il5', company_id: CO_B, location_id: LOC_A, product_id: CLEAR,   on_hand: 2 }
        ],
        kit_consumptions: [
            { id: 'k1', company_id: CO_A, location_id: LOC_A, kit_name: 'Door Skin',   job_ref: 'RO-100', total_cost: 300, line_count: 4, created_at: RECENT },
            { id: 'k2', company_id: CO_A, location_id: LOC_A, kit_name: 'Door Skin',   job_ref: 'RO-101', total_cost: 320, line_count: 4, created_at: RECENT },
            { id: 'k3', company_id: CO_A, location_id: LOC_A, kit_name: 'Hood Replace', job_ref: 'RO-100', total_cost: 150, line_count: 3, created_at: RECENT },
            { id: 'k4', company_id: CO_B, location_id: LOC_A, kit_name: 'Door Skin',   job_ref: 'RO-900', total_cost: 280, line_count: 4, created_at: RECENT }
        ],
        v_job_materials: [
            { company_id: CO_A, company_name: 'Assured Collision', location_name: 'Burlington', job_ref: 'RO-100',
              first_used_at: RECENT, last_used_at: RECENT, distinct_items: 7, units_used: 9.4,
              value_billed: 450, items_unpriced: 0, kits_used: 2, kit_movements: 7 },
            { company_id: CO_A, company_name: 'Assured Collision', location_name: 'Burlington', job_ref: 'RO-101',
              first_used_at: RECENT, last_used_at: RECENT, distinct_items: 5, units_used: 4.2,
              value_billed: 320, items_unpriced: 1, kits_used: 1, kit_movements: 5 },
            { company_id: CO_B, company_name: 'Bayview Auto Body', location_name: 'Burlington', job_ref: 'RO-900',
              first_used_at: RECENT, last_used_at: RECENT, distinct_items: 3, units_used: 3,
              value_billed: 280, items_unpriced: 0, kits_used: 0, kit_movements: 0 }
        ],
        ...extra
    });
}

function app() {
    const a = express();
    a.use(express.json());
    a.use((req, res, next) => { req.admin = authAdmin; next(); });
    a.use('/dashboard', dashboard);
    return a;
}

function reset(extra) {
    fake = seed(extra);
    authAdmin = { id: 'admin-1', role: 'super_admin', company_id: null };
}

const get = (url) => request(app()).get(url);

// ==================================================================
// Sales
// ==================================================================

test('sales exclude cancelled orders', async () => {
    reset();
    const res = await get('/dashboard?period=this_year');
    assert.equal(res.status, 200);
    // 2100 + 400 + 0 (A) + 600 (B). The 99,999 cancelled order is not money.
    assert.equal(res.body.totals.sales_total, 3100);
    assert.equal(res.body.totals.order_count, 4);
    const b = res.body.by_company.find(c => c.company_id === CO_B);
    assert.equal(b.sales_total, 600, 'a cancelled order must not reach the customer row either');
    assert.equal(b.order_count, 1);
});

test('a price-on-request line contributes units but never dollars', async () => {
    reset();
    const res = await get('/dashboard?period=this_year');
    assert.equal(res.body.totals.unpriced_lines, 1);

    const booth = res.body.top_products_by_units.find(p => p.sku === 'BOOTH-1');
    assert.ok(booth, 'a quoted item still moved units and must appear');
    assert.equal(booth.units, 2);
    assert.equal(booth.dollars, 0, 'it has no price — it must not invent one');

    // And it must not be silently dropped from the by-customer row.
    const a = res.body.by_company.find(c => c.company_id === CO_A);
    assert.equal(a.unpriced_lines, 1);
});

test('a customer with no activity is still a row, not an omission', async () => {
    reset();
    const res = await get('/dashboard?period=this_year');
    const quiet = res.body.by_company.find(c => c.company_id === CO_C);
    assert.ok(quiet, 'a customer who bought nothing must still be listed');
    assert.equal(quiet.sales_total, 0);
    assert.equal(quiet.order_count, 0);
    assert.equal(res.body.totals.companies_total, 3);
    assert.equal(res.body.totals.customers_ordering, 2);
});

test('top products by units and by dollars are genuinely different rankings', async () => {
    reset();
    const res = await get('/dashboard?period=this_year');
    // Tape: 50 units / $500. Clear: 13 units / $2,600.
    assert.equal(res.body.top_products_by_units[0].sku, 'MMM06334');
    assert.equal(res.body.top_products_by_units[0].units, 50);
    assert.equal(res.body.top_products_by_dollars[0].sku, 'PRF611N');
    assert.equal(res.body.top_products_by_dollars[0].dollars, 2600);
});

test('a product bought by two customers reports both', async () => {
    reset();
    const res = await get('/dashboard?period=this_year');
    const clear = res.body.top_products_by_dollars.find(p => p.sku === 'PRF611N');
    assert.equal(clear.company_count, 2);
});

test('a part sold under different SKUs by two shops collapses into one master row', async () => {
    // Real order lines carry a genuine products-table UUID as product_id
    // (see routes/storefront.js), not the SKU string the line() fixture
    // helper uses above — so this test builds its own orders by hand to
    // exercise the v_product_master lookup at all.
    const MASTER_A = 'bbbbbbb1-1111-4111-8111-111111111111';   // Assured's own catalogue entry
    const MASTER_B = 'bbbbbbb2-2222-4222-8222-222222222222';   // Bayview's own entry, different SKU, same part
    const UNMATCHED = 'bbbbbbb3-3333-4333-8333-333333333333';  // no confident resolution

    reset({
        v_product_master: [
            { product_id: MASTER_A, master_sku: 'CHC-9000', master_name: 'Premium Base Coat', match_type: 'exact' },
            { product_id: MASTER_B, master_sku: 'CHC-9000', master_name: 'Premium Base Coat', match_type: 'alias' },
            { product_id: UNMATCHED, master_sku: null, master_name: null, match_type: 'unmatched' }
        ],
        orders: [
            { id: 'mo1', company_id: CO_A, order_number: 'A-MASTER-1', status: 'closed', total: 500, created_at: RECENT,
              items: [{ product_id: MASTER_A, sku: 'PRF-BASE-A', name: "Assured's Base Coat", quantity: 5, unit_price: 100 }] },
            { id: 'mo2', company_id: CO_B, order_number: 'B-MASTER-1', status: 'closed', total: 300, created_at: RECENT,
              items: [{ product_id: MASTER_B, sku: 'BAY-0091', name: "Bayview's Base Coat", quantity: 3, unit_price: 100 }] },
            { id: 'mo3', company_id: CO_A, order_number: 'A-UNMATCHED-1', status: 'closed', total: 60, created_at: RECENT,
              items: [{ product_id: UNMATCHED, sku: 'A-HOUSE-1', name: 'Shop-only widget', quantity: 6, unit_price: 10 }] }
        ]
    });

    const res = await get('/dashboard?period=this_year');
    assert.equal(res.status, 200);

    const master = res.body.top_products_by_units.find(p => p.sku === 'CHC-9000');
    assert.ok(master, "the two shops' lines must collapse into one master-SKU row");
    assert.equal(master.name, 'Premium Base Coat');
    assert.equal(master.units, 8, '5 from Assured + 3 from Bayview');
    assert.equal(master.dollars, 800);
    assert.equal(master.company_count, 2);
    assert.equal(master.grouped_by_master, true);

    // Neither shop's own SKU should survive as a separate row once resolved.
    assert.ok(!res.body.top_products_by_units.find(p => p.sku === 'PRF-BASE-A'));
    assert.ok(!res.body.top_products_by_units.find(p => p.sku === 'BAY-0091'));

    const unmatched = res.body.top_products_by_units.find(p => p.sku === 'A-HOUSE-1');
    assert.ok(unmatched, "a line with no confident master match keeps grouping by the shop's own SKU");
    assert.equal(unmatched.grouped_by_master, false);
    assert.equal(unmatched.company_count, 1);
});

// ==================================================================
// Period handling
// ==================================================================

test('the period actually filters — last year is out of "this year"', async () => {
    reset();
    const thisYearRes = await get('/dashboard?period=this_year');
    const allRes = await get('/dashboard?period=all');
    assert.equal(thisYearRes.body.totals.sales_total, 3100);
    assert.equal(allRes.body.totals.sales_total, 8100, 'all time must include the older order');
    assert.ok(allRes.body.monthly.length >= 2, 'two different months must produce two trend points');
});

test('kit consumption respects the period too', async () => {
    reset();
    const res = await get('/dashboard?period=last_year');
    assert.equal(res.body.totals.kits_consumed, 0,
        'no kits were consumed last year — the period must apply to consumption, not just to orders');
});

// ==================================================================
// Inventory
// ==================================================================

test('stock value skips unpriced and inactive items but still counts real units', async () => {
    reset();
    const res = await get('/dashboard?period=this_year');
    const a = res.body.by_company.find(c => c.company_id === CO_A);

    // Priced and active: 6 x $200 + 100 x $10 = $2,200.
    // The booth (3 on hand, no price) adds units but no dollars.
    // The discontinued product (9 on hand, $500) is excluded entirely.
    assert.equal(a.inventory_value, 2200);
    assert.equal(a.inventory_units, 109, '6 + 100 + 3; the inactive product is not stock we sell');
    assert.equal(a.inventory_unvalued, 1);

    assert.equal(res.body.totals.inventory_value, 2600, 'plus Bayview: 2 x $200');
    assert.equal(res.body.totals.inventory_unvalued_skus, 1);
});

test('stock is a point-in-time figure and does not move with the period', async () => {
    reset();
    const now = await get('/dashboard?period=this_month');
    const old = await get('/dashboard?period=last_year');
    assert.equal(now.body.totals.inventory_value, old.body.totals.inventory_value,
        'what is on the shelf today is the same number whichever period is selected');
});

// ==================================================================
// Repair work
// ==================================================================

test('repairs roll up by kit and by customer', async () => {
    reset();
    const res = await get('/dashboard?period=this_year');
    assert.equal(res.body.totals.kits_consumed, 4);
    assert.equal(res.body.totals.kits_value, 1050);

    const doorSkin = res.body.kits.find(k => k.kit_name === 'Door Skin');
    assert.equal(doorSkin.count, 3, 'Door Skin across both customers');
    assert.equal(doorSkin.value, 900);
    assert.equal(res.body.kits[0].kit_name, 'Door Skin', 'the most-billed repair sorts first');

    const aDoor = res.body.kits_by_company.find(k => k.company_id === CO_A && k.kit_name === 'Door Skin');
    assert.equal(aDoor.count, 2);
    assert.equal(aDoor.value, 620);
    assert.equal(aDoor.company_name, 'Assured Collision');
});

test('two kits on one repair order count as one job', async () => {
    reset();
    const res = await get('/dashboard?period=this_year');
    const a = res.body.by_company.find(c => c.company_id === CO_A);
    // RO-100 took two kits and RO-101 took one: three consumptions, two jobs.
    assert.equal(a.kits_consumed, 3);
    assert.equal(a.jobs_with_materials, 2);
});

// ==================================================================
// Tenancy
// ==================================================================

test('a company admin sees only their own company, whatever they ask for', async () => {
    reset();
    authAdmin = { id: 'admin-2', role: 'company_admin', company_id: CO_A };

    const res = await get(`/dashboard?period=this_year&company_id=${CO_B}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.by_company.length, 1);
    assert.equal(res.body.by_company[0].company_id, CO_A);
    assert.equal(res.body.totals.sales_total, 2500, 'Bayview\'s $600 must not be in here');
    assert.equal(res.body.scope.is_super, false);

    const jobs = await get(`/dashboard/jobs?period=this_year&company_id=${CO_B}`);
    assert.equal(jobs.body.jobs.length, 2);
    assert.ok(jobs.body.jobs.every(j => j.company_id === CO_A));
});

test('a company admin with no company gets nothing rather than everything', async () => {
    reset();
    authAdmin = { id: 'admin-3', role: 'company_admin', company_id: null };
    const res = await get('/dashboard?period=this_year');
    assert.equal(res.status, 403);
});

test('a super admin may narrow to one customer on purpose', async () => {
    reset();
    const res = await get(`/dashboard?period=this_year&company_id=${CO_B}`);
    assert.equal(res.body.by_company.length, 1);
    assert.equal(res.body.by_company[0].company_id, CO_B);
    assert.equal(res.body.scope.company_id, CO_B);
});

test('a junk company_id is ignored rather than obeyed', async () => {
    reset();
    const res = await get('/dashboard?period=this_year&company_id=not-a-uuid');
    assert.equal(res.status, 200);
    assert.equal(res.body.by_company.length, 3, 'an unparseable filter must not narrow or widen anything');
});

test('order-desk roles are fenced out of the dashboard', () => {
    // The fence is an allow-list, so this is really asserting that nobody
    // added /dashboard to it. Exercised against the real middleware.
    for (const role of ['order_desk', 'order_manager']) {
        let status = null;
        const res = { status(c) { status = c; return this; }, json() { return this; } };
        let passed = false;
        restrictOrderDesk({ admin: { role }, method: 'GET', path: '/dashboard' }, res, () => { passed = true; });
        assert.equal(passed, false, `${role} must not reach the dashboard`);
        assert.equal(status, 403);
    }
    // And a full admin still passes through.
    let passed = false;
    restrictOrderDesk({ admin: { role: 'super_admin' }, method: 'GET', path: '/dashboard' }, {}, () => { passed = true; });
    assert.equal(passed, true);
});

// ==================================================================
// Reads that must not silently stop
// ==================================================================

test('more than one page of orders is read in full', async () => {
    // The classic version of this bug returns 1000 rows, reports a smaller
    // business than the customer has, and nobody notices for a quarter.
    const many = [];
    for (let i = 0; i < 2350; i++) {
        many.push({
            id: `bulk-${i}`, company_id: CO_A, order_number: `BULK-${i}`, status: 'closed',
            total: 1, created_at: RECENT, items: [line('MMM06334', 'Masking Tape', 1, 1)]
        });
    }
    reset({ orders: many });
    const res = await get('/dashboard?period=this_year');
    assert.equal(res.body.totals.order_count, 2350);
    assert.equal(res.body.totals.sales_total, 2350);
    assert.equal(res.body.partial.orders, false, 'a complete read must not be flagged partial');
});

test('more than one page of stock rows is read in full', async () => {
    const levels = [];
    for (let i = 0; i < 1500; i++) {
        levels.push({ id: `bl-${i}`, company_id: CO_A, location_id: LOC_A, product_id: TAPE, on_hand: 1 });
    }
    reset({ inventory_levels: levels });
    const res = await get('/dashboard?period=this_year');
    assert.equal(res.body.totals.inventory_units, 1500);
    assert.equal(res.body.totals.inventory_value, 15000);
});

// ==================================================================
// Job materials — the reconciliation view
// ==================================================================

test('job materials summarise what left the shelf against each RO', async () => {
    reset();
    const res = await get('/dashboard/jobs?period=this_year');
    assert.equal(res.status, 200);
    assert.equal(res.body.totals.job_count, 3);
    assert.equal(res.body.totals.value_billed, 1050);
    assert.equal(res.body.totals.jobs_with_unpriced, 1);
});

test('a job drawn entirely by hand is flagged, because that is the one that gets under-billed', async () => {
    reset();
    const res = await get('/dashboard/jobs?period=this_year');
    assert.equal(res.body.totals.jobs_hand_scanned_only, 1);
    const ro900 = res.body.jobs.find(j => j.job_ref === 'RO-900');
    assert.equal(ro900.hand_scanned_only, true);
    const ro100 = res.body.jobs.find(j => j.job_ref === 'RO-100');
    assert.equal(ro100.hand_scanned_only, false);
    assert.equal(ro100.kits_used, 2);
});

test('the CSV export is a real CSV with the money in it', async () => {
    reset();
    const res = await get('/dashboard/jobs?period=this_year&format=csv');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/csv/);
    assert.match(res.headers['content-disposition'], /attachment; filename=/);

    const text = res.text.replace(/^﻿/, '');
    const lines = text.trim().split('\r\n');
    assert.equal(lines.length, 4, 'a header plus one row per repair order');
    assert.match(lines[0], /^Customer,Location,Repair Order/);
    assert.ok(lines.some(l => l.includes('RO-100') && l.includes('450.00')));
});

test('a customer name containing a comma does not break the CSV', async () => {
    reset({
        v_job_materials: [
            { company_id: CO_A, company_name: 'Smith, Jones & Co', location_name: 'Burlington', job_ref: 'RO-1',
              first_used_at: RECENT, last_used_at: RECENT, distinct_items: 1, units_used: 1,
              value_billed: 10, items_unpriced: 0, kits_used: 1, kit_movements: 1 }
        ]
    });
    const res = await get('/dashboard/jobs?period=this_year&format=csv');
    const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[1].startsWith('"Smith, Jones & Co",'),
        'a comma in a name must be quoted, not allowed to shift every column right');
});

// ==================================================================
// Shape
// ==================================================================

test('an empty system returns zeroes, not an error', async () => {
    fake = createFakeSupabase({ companies: [] });
    authAdmin = { id: 'admin-1', role: 'super_admin', company_id: null };
    const res = await get('/dashboard?period=this_month');
    assert.equal(res.status, 200);
    assert.equal(res.body.totals.sales_total, 0);
    assert.equal(res.body.totals.inventory_value, 0);
    assert.deepEqual(res.body.by_company, []);
    assert.deepEqual(res.body.kits, []);
});

test('the period label is carried back so the screen can say what it is showing', async () => {
    reset();
    const res = await get('/dashboard?period=last_year');
    assert.equal(res.body.period.label, `Year ${thisYear - 1}`);
    assert.equal(res.body.period.key, 'last_year');
});

// ==================================================================
// The .not() filter the dashboard leans on
// ==================================================================

test('the cancelled-order filter is a real filter, not a no-op', async () => {
    // The route filters cancelled orders twice: once in the query with .not(),
    // once in JS. Until the fake understood .not(), only the JS half was ever
    // exercised — so this asserts the query half independently.
    reset();
    const { createFakeSupabase } = require('./helpers/fake-supabase');
    const db = createFakeSupabase({
        orders: [
            { id: 'a', company_id: CO_A, status: 'closed', total: 10, created_at: RECENT, items: [] },
            { id: 'b', company_id: CO_A, status: 'cancelled', total: 999, created_at: RECENT, items: [] }
        ]
    });
    const { data } = await db.from('orders').select('id, status').not('status', 'in', '(cancelled)');
    assert.equal(data.length, 1, '.not() must actually exclude the row');
    assert.equal(data[0].id, 'a');

    const { data: withBarcode } = await createFakeSupabase({
        product_barcodes: [
            { id: '1', product_id: 'p1', barcode: '123' },
            { id: '2', product_id: 'p2', barcode: null }
        ]
    }).from('product_barcodes').select('id').not('barcode', 'is', null);
    assert.equal(withBarcode.length, 1, '.not(col, is, null) must exclude the null');
});
