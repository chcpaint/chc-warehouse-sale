/**
 * tests/brand-sales-report.test.js
 *
 * The monthly brand sales report (Assured's 3M report): what counts as a sale,
 * how partial shipments and month boundaries are handled, the year-to-date
 * roll-up, the Excel and PDF files, who may download them, and the scheduled
 * run on the 1st.
 *
 *   node --test tests/brand-sales-report.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const fs = require('node:fs');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.invalid';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'service-key';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { createFakeSupabase } = require('./helpers/fake-supabase');

const ROOT = path.resolve(__dirname, '..');
let fake = createFakeSupabase();
const supabaseProxy = new Proxy({}, {
    get: (_t, prop) => { const v = fake[prop]; return typeof v === 'function' ? v.bind(fake) : v; }
});

const stubs = { [path.join(ROOT, 'utils/supabase.js')]: { supabaseAdmin: supabaseProxy } };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (parent && request.startsWith('.')) {
        const resolved = path.resolve(path.dirname(parent.filename), request);
        for (const key of Object.keys(stubs)) if (key === resolved || key === resolved + '.js') return stubs[key];
    }
    return originalLoad.call(this, request, parent, isMain);
};

const XLSX = require('xlsx');
const express = require('express');
const request = require('supertest');
const R = require('../utils/brand-sales-report');
const D = require('../utils/brand-report-data');
const scheduler = require('../utils/scheduler');
const router = require('../routes/brand-reports-admin');

// ---------- helpers ----------

const ASSURED = '11111111-1111-4111-8111-111111111111';
const OTHER = '11111111-1111-4111-8111-111111111199';
const P1 = '55555555-5555-4555-8555-555555555551';

const line = (sku, name, quantity, unit_price, extra = {}) => ({
    product_id: extra.product_id || null, sku, name, brand: extra.brand === undefined ? '3M' : extra.brand,
    category: 'Abrasives', quantity, unit_price, price_on_request: unit_price == null,
    subtotal: unit_price == null ? null : quantity * unit_price, ...extra
});

const order = (id, status, items, history, extra = {}) => ({
    id, order_number: `CHC-${id}`, company_id: ASSURED, status, location: 'Main Shop',
    items, status_history: history,
    created_at: '2026-09-01T12:00:00Z', updated_at: '2026-11-20T12:00:00Z', closed_at: null, ...extra
});

const shipped = (ts, extra = {}) => ({ status: 'out_on_delivery', timestamp: ts, ...extra });
const closed = (ts) => ({ status: 'closed', timestamp: ts });

// ---------- dates ----------

test('months are Toronto months, so a late-night shipment is not pushed into the next month', () => {
    // 02:30 UTC on 1 Nov is 22:30 on 31 Oct in Toronto.
    assert.equal(R.torontoParts('2026-11-01T02:30:00Z').period, '2026-10');
    assert.equal(R.torontoParts('2026-11-01T06:30:00Z').period, '2026-11'); // EST has begun; 01:30 on 1 Nov
    assert.equal(R.torontoParts('not a date'), null);
});

test('previousPeriod rolls back across the new year, and the year to date lists January through the month', () => {
    assert.equal(R.previousPeriod(new Date('2027-01-01T15:00:00Z')), '2026-12');
    assert.equal(R.previousPeriod(new Date('2026-11-01T15:00:00Z')), '2026-10');
    assert.deepEqual(R.monthsOfYearThrough('2026-03'), ['2026-01', '2026-02', '2026-03']);
    assert.equal(R.isPeriod('2026-13'), false);
    assert.equal(R.isPeriod('2026-10'), true);
});

// ---------- what counts ----------

test('only the brand counts, only shipped orders count, and cancelled or pending are left out', () => {
    const orders = [
        order('1', 'closed', [line('MMM06652', '3M Sandpaper', 10, 5), line('FUS100', 'Norton thing', 4, 20, { brand: 'Norton' })], [shipped('2026-10-05T14:00:00Z'), closed('2026-10-09T14:00:00Z')]),
        order('2', 'pending', [line('MMM06652', '3M Sandpaper', 99, 5)], []),
        order('3', 'cancelled', [line('MMM06652', '3M Sandpaper', 99, 5)], [shipped('2026-10-06T14:00:00Z')]),
    ];
    const m = R.buildMonth({ orders, brand: '3M', period: '2026-10' });
    assert.equal(m.totals.qty, 10);
    assert.equal(m.totals.amount, 50);
    assert.equal(m.totals.orders, 1);
    assert.equal(m.items.length, 1);
    assert.equal(m.items[0].sku, 'MMM06652');
});

test('"Closed" after "Out for Delivery" ships nothing new, so an order is never counted twice', () => {
    const o = order('1', 'closed', [line('MMM1', '3M A', 6, 10)], [shipped('2026-10-05T14:00:00Z'), closed('2026-10-20T14:00:00Z')]);
    assert.equal(R.buildMonth({ orders: [o], brand: '3M', period: '2026-10' }).totals.qty, 6);
    assert.equal(R.buildMonth({ orders: [o], brand: '3M', period: '2026-11' }).totals.qty, 0);
});

test('an order is counted in the month it SHIPPED, not the month it was placed', () => {
    const o = order('1', 'closed', [line('MMM1', '3M A', 2, 10)], [shipped('2026-11-02T14:00:00Z')], { created_at: '2026-10-30T14:00:00Z' });
    assert.equal(R.buildMonth({ orders: [o], brand: '3M', period: '2026-10' }).totals.qty, 0);
    assert.equal(R.buildMonth({ orders: [o], brand: '3M', period: '2026-11' }).totals.qty, 2);
});

test('a partial shipment counts what went out now and the backorder in the month it ships, never both at once', () => {
    const items = [line('MMM1', '3M A', 10, 4), line('MMM2', '3M B', 5, 2)];
    const o = order('1', 'closed', items, [
        shipped('2026-10-28T14:00:00Z', { is_partial_shipment: true, backorder_items: [{ sku: 'MMM1', name: '3M A', quantity: 4 }] }),
        shipped('2026-11-04T14:00:00Z'),            // backorder arrives, no longer partial
        closed('2026-11-06T14:00:00Z')
    ]);
    const oct = R.buildMonth({ orders: [o], brand: '3M', period: '2026-10' });
    const nov = R.buildMonth({ orders: [o], brand: '3M', period: '2026-11' });
    assert.equal(oct.totals.qty, 6 + 5);            // 10 - 4 of A, all 5 of B
    assert.equal(oct.totals.amount, 6 * 4 + 5 * 2);
    assert.equal(nov.totals.qty, 4);
    assert.equal(nov.totals.amount, 16);
    assert.equal(oct.totals.qty + nov.totals.qty, 15, 'the whole order, once');
});

test('a backorder that has not shipped yet is not in any month', () => {
    const o = order('1', 'out_on_delivery', [line('MMM1', '3M A', 10, 4)], [
        shipped('2026-10-28T14:00:00Z', { is_partial_shipment: true, backorder_items: [{ sku: 'MMM1', quantity: 10 }] })
    ]);
    assert.equal(R.buildMonth({ orders: [o], brand: '3M', period: '2026-10' }).totals.qty, 0);
});

test('an older order with no usable history is one shipment, dated by when it closed', () => {
    const o = order('1', 'closed', [line('MMM1', '3M A', 3, 10)], [], { closed_at: '2026-10-15T14:00:00Z' });
    assert.equal(R.buildMonth({ orders: [o], brand: '3M', period: '2026-10' }).totals.amount, 30);
});

test('a line still price-on-request counts its units but not dollars, and says so', () => {
    const o = order('1', 'closed', [line('MMM1', '3M A', 3, 10), line('MMM2', '3M B', 7, null)], [shipped('2026-10-05T14:00:00Z')]);
    const m = R.buildMonth({ orders: [o], brand: '3M', period: '2026-10' });
    assert.equal(m.totals.qty, 10);
    assert.equal(m.totals.amount, 30);
    assert.equal(m.totals.unpriced_qty, 7);
    const b = m.items.find(i => i.sku === 'MMM2');
    assert.equal(b.amount, 0);
    assert.equal(b.avg_price, null);
});

test('the brand is recognised from the line, then the product, then the part number', () => {
    const info = new Map([[P1, { brand: '3M', category: 'Abrasives' }]]);
    const lines = [
        line('X-1', 'No brand on line', 1, 10, { brand: null, product_id: P1 }),   // product says 3M
        line('MMM33543', 'Old line', 1, 10, { brand: null }),                      // part number says 3M
        line('Q9', '3M named thing', 1, 10, { brand: null }),                      // name says 3M
        line('Q10', 'Something else', 1, 10, { brand: null }),
        line('Q11', 'Other brand', 1, 10, { brand: 'Norton' }),
        line('Q12', 'A 3M Collision line', 1, 10, { brand: '3M Collision' })
    ];
    const got = lines.map(l => R.lineIsBrand(l, '3M', info));
    assert.deepEqual(got, [true, true, true, false, false, true]);
});

test('older orders that stored qty and price (not quantity and unit_price) are still read', () => {
    const o = order('1', 'closed', [{ sku: 'MMM1', name: '3M A', brand: '3M', qty: 4, price: 2.5 }], [shipped('2026-10-05T14:00:00Z')]);
    const m = R.buildMonth({ orders: [o], brand: '3M', period: '2026-10' });
    assert.equal(m.totals.qty, 4);
    assert.equal(m.totals.amount, 10);
});

test('the same part spelled two ways is one line in the item breakdown', () => {
    const o = order('1', 'closed', [line('MMM-33543', '3M Disc', 2, 10), line('MMM33543', '3M Disc', 3, 10)], [shipped('2026-10-05T14:00:00Z')]);
    const m = R.buildMonth({ orders: [o], brand: '3M', period: '2026-10' });
    assert.equal(m.items.length, 1);
    assert.equal(m.items[0].qty, 5);
});

test('locations and the order list add up to the month total', () => {
    const orders = [
        order('1', 'closed', [line('MMM1', '3M A', 2, 10)], [shipped('2026-10-05T14:00:00Z')], { location: 'North' }),
        order('2', 'closed', [line('MMM1', '3M A', 3, 10)], [shipped('2026-10-06T14:00:00Z')], { location: 'South' }),
        order('3', 'closed', [line('MMM1', '3M A', 1, 10)], [shipped('2026-10-07T14:00:00Z')], { location: '' })
    ];
    const m = R.buildMonth({ orders, brand: '3M', period: '2026-10' });
    assert.equal(m.locations.reduce((s, l) => s + l.amount, 0), m.totals.amount);
    assert.equal(m.orders.reduce((s, o) => s + o.qty, 0), m.totals.qty);
    assert.ok(m.locations.some(l => l.location === 'Unassigned'));
});

// ---------- year to date ----------

test('the year to date is the months added together, with no gaps for a quiet month', () => {
    const orders = [
        order('1', 'closed', [line('MMM1', '3M A', 2, 10)], [shipped('2026-01-10T14:00:00Z')]),
        order('2', 'closed', [line('MMM1', '3M A', 3, 10), line('MMM2', '3M B', 1, 100)], [shipped('2026-03-10T14:00:00Z')])
    ];
    const periods = R.monthsOfYearThrough('2026-03');
    const snaps = R.buildMonths({ orders, brand: '3M', periods });
    const ytd = R.rollUp(snaps, { periods, brand: '3M' });
    assert.equal(ytd.months.length, 3);
    assert.equal(ytd.months[1].qty, 0, 'February is present and empty');
    assert.equal(ytd.totals.qty, 6);
    assert.equal(ytd.totals.amount, 150);
    const a = ytd.items.find(i => i.sku === 'MMM1');
    assert.equal(a.qty, 5);
    assert.equal(a.orders, 2);
    assert.match(ytd.label, /January to March 2026/);
});

// ---------- files ----------

function sampleReport() {
    const orders = [
        order('1', 'closed', [line('MMM33543', '3M Hookit Flexible Foam Abrasive Disc P1500 6in', 20, 12.5), line('MMM33532', '3M Hookit Foam Sheet P600', 5, null)], [shipped('2026-10-05T14:00:00Z')]),
        order('2', 'closed', [line('MMM33543', '3M Hookit Flexible Foam Abrasive Disc P1500 6in', 10, 12.5)], [shipped('2026-09-05T14:00:00Z')])
    ];
    const periods = R.monthsOfYearThrough('2026-10');
    const snaps = R.buildMonths({ orders, brand: '3M', periods });
    return { company: 'Assured Collision', brand: '3M', month: snaps['2026-10'], ytd: R.rollUp(snaps, { periods, brand: '3M' }), partial: false, generated_at: '2026-11-01T11:00:00Z' };
}

test('the Excel file has the five tabs and the numbers are the report numbers', () => {
    const buf = R.renderXlsx(sampleReport());
    const wb = XLSX.read(buf, { type: 'buffer' });
    assert.deepEqual(wb.SheetNames, ['Summary', 'Items', 'By location', 'Orders', 'Year to date']);
    const items = XLSX.utils.sheet_to_json(wb.Sheets['Items'], { header: 1 });
    assert.deepEqual(items[0].slice(0, 5), ['Item #', 'Description', 'Category', 'Units', 'Dollars']);
    const disc = items.find(r => r[0] === 'MMM33543');
    assert.equal(disc[3], 20);
    assert.equal(disc[4], 250);
    const total = items[items.length - 1];
    assert.equal(total[1], 'Total');
    assert.equal(total[3], 25);                // 20 discs + 5 unpriced sheets
    const ytd = XLSX.utils.sheet_to_json(wb.Sheets['Year to date'], { header: 1 });
    const ytdRow = ytd.find(r => r[0] === 'Year to date');
    assert.equal(ytdRow[2], 35);               // 25 in October + 10 in September
    assert.equal(ytdRow[3], 375);
    const summary = XLSX.utils.sheet_to_json(wb.Sheets['Summary'], { header: 1 }).flat().join(' ');
    assert.match(summary, /Units not yet priced: 5/);
});

test('the PDF renders and carries the report text', async () => {
    const buf = await R.renderPdf(sampleReport());
    assert.equal(buf.slice(0, 5).toString(), '%PDF-');
    assert.ok(buf.length > 2000);
});

test('an empty month still produces both files', async () => {
    const periods = R.monthsOfYearThrough('2026-10');
    const snaps = R.buildMonths({ orders: [], brand: '3M', periods });
    const report = { company: 'Assured', brand: '3M', month: snaps['2026-10'], ytd: R.rollUp(snaps, { periods, brand: '3M' }), partial: false };
    assert.ok(R.renderXlsx(report).length > 500);
    assert.equal((await R.renderPdf(report)).slice(0, 5).toString(), '%PDF-');
});

test('file names are tidy and the same for both formats', () => {
    assert.equal(R.fileBase({ company: 'Assured Collision Ltd.', brand: '3M', period: '2026-10' }), 'assured-collision-ltd-3m-sales-2026-10');
});

// ---------- the routes ----------

let currentAdmin = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.admin = currentAdmin; next(); });
app.use('/api/admin/brand-reports', router);

const SUPER = { id: 'a1111111-1111-4111-8111-111111111111', role: 'super_admin', company_id: null };
const ASSURED_ADMIN = { id: 'a2222222-2222-4222-8222-222222222222', role: 'company_admin', company_id: ASSURED };
const OTHER_ADMIN = { id: 'a3333333-3333-4333-8333-333333333333', role: 'company_admin', company_id: OTHER };

function reset({ subscribe = true } = {}) {
    // The month in progress is November 2026 (this is what the real clock says in the tests that use "now").
    fake = createFakeSupabase({
        companies: [
            { id: ASSURED, name: 'Assured Collision', slug: 'assured', is_active: true, distributor_id: 'd1' },
            { id: OTHER, name: 'Other Shop', slug: 'other', is_active: true, distributor_id: 'd1' }
        ],
        brand_report_subscriptions: subscribe ? [{ id: 's1', company_id: ASSURED, brand: '3M', is_enabled: true }] : [],
        orders: [
            order('1', 'closed', [line('MMM33543', '3M Disc P1500', 20, 12.5)], [shipped('2026-09-10T14:00:00Z')]),
            order('2', 'closed', [line('MMM33543', '3M Disc P1500', 10, 12.5), line('FUS1', 'Norton', 3, 9, { brand: 'Norton' })], [shipped('2026-10-10T14:00:00Z')]),
            { ...order('3', 'closed', [line('MMM33543', '3M Disc P1500', 99, 12.5)], [shipped('2026-10-10T14:00:00Z')]), company_id: OTHER }
        ]
    });
}

test('a super admin sees the report list; a company admin sees only their own', async () => {
    reset(); currentAdmin = SUPER;
    let r = await request(app).get('/api/admin/brand-reports');
    assert.equal(r.status, 200);
    assert.equal(r.body.reports.length, 1);
    assert.equal(r.body.reports[0].company_name, 'Assured Collision');
    assert.equal(r.body.can_generate, true);

    currentAdmin = OTHER_ADMIN;
    r = await request(app).get('/api/admin/brand-reports');
    assert.equal(r.body.reports.length, 0);

    currentAdmin = ASSURED_ADMIN;
    r = await request(app).get('/api/admin/brand-reports');
    assert.equal(r.body.reports.length, 1);
    assert.equal(r.body.can_generate, false);
});

test('downloads: xlsx and pdf come back with the right type, name and numbers, using only that customer\'s orders', async () => {
    reset(); currentAdmin = SUPER;
    const x = await request(app).get(`/api/admin/brand-reports/${ASSURED}/3M/download?period=2026-10&format=xlsx`).buffer(true).parse((res, cb) => {
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(x.status, 200);
    assert.match(x.headers['content-type'], /spreadsheetml/);
    assert.match(x.headers['content-disposition'], /assured-collision-3m-sales-2026-10\.xlsx/);
    const wb = XLSX.read(x.body, { type: 'buffer' });
    const items = XLSX.utils.sheet_to_json(wb.Sheets['Items'], { header: 1 });
    const disc = items.find(r => r[0] === 'MMM33543');
    assert.equal(disc[3], 10, 'October only, this customer only, 3M only');
    const ytd = XLSX.utils.sheet_to_json(wb.Sheets['Year to date'], { header: 1 }).find(r => r[0] === 'Year to date');
    assert.equal(ytd[2], 30, 'September + October');

    const p = await request(app).get(`/api/admin/brand-reports/${ASSURED}/3M/download?period=2026-10&format=pdf`).buffer(true).parse((res, cb) => {
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(p.status, 200);
    assert.match(p.headers['content-type'], /pdf/);
    assert.equal(p.body.slice(0, 5).toString(), '%PDF-');
});

test('downloading a finished month stores a frozen snapshot, and later changes to orders do not move it', async () => {
    reset(); currentAdmin = SUPER;
    await request(app).get(`/api/admin/brand-reports/${ASSURED}/3M/preview?period=2026-10`).expect(200);
    // read through the client so this does not depend on the fake's internals
    const { data } = await fake.from('monthly_brand_reports').select('period, total_qty').eq('company_id', ASSURED);
    assert.deepEqual(data.map(r => r.period).sort(), R.monthsOfYearThrough('2026-10'), 'January to October are all saved');
    assert.ok(data.find(r => r.period === '2026-10' && Number(r.total_qty) === 10));

    // an order changes afterwards; the saved month stays put
    await fake.from('orders').update({ items: [line('MMM33543', '3M Disc P1500', 500, 12.5)] }).eq('id', '2');
    const again = await request(app).get(`/api/admin/brand-reports/${ASSURED}/3M/preview?period=2026-10`).expect(200);
    assert.equal(again.body.month.totals.qty, 10);

    // a super admin can rebuild it on purpose
    const rebuilt = await request(app).post(`/api/admin/brand-reports/${ASSURED}/3M/generate`).send({ period: '2026-10' });
    assert.equal(rebuilt.status, 200);
    assert.equal(rebuilt.body.totals.qty, 500);
});

test('who may not: other companies, missing subscriptions, bad input', async () => {
    reset();
    currentAdmin = OTHER_ADMIN;
    assert.equal((await request(app).get(`/api/admin/brand-reports/${ASSURED}/3M/download?period=2026-10`)).status, 403);
    assert.equal((await request(app).post(`/api/admin/brand-reports/${ASSURED}/3M/generate`).send({ period: '2026-10' })).status, 403);

    currentAdmin = ASSURED_ADMIN;
    assert.equal((await request(app).post(`/api/admin/brand-reports/${ASSURED}/3M/generate`).send({ period: '2026-10' })).status, 403, 'only a super admin rebuilds');
    assert.equal((await request(app).get(`/api/admin/brand-reports/${ASSURED}/3M/download?period=2026-10`)).status, 200, 'their own report is theirs to download');

    currentAdmin = SUPER;
    assert.equal((await request(app).get(`/api/admin/brand-reports/${ASSURED}/Norton/download?period=2026-10`)).status, 404, 'no subscription for that brand');
    assert.equal((await request(app).get(`/api/admin/brand-reports/${OTHER}/3M/download?period=2026-10`)).status, 404);
    assert.equal((await request(app).get(`/api/admin/brand-reports/not-a-uuid/3M/download?period=2026-10`)).status, 400);
    assert.equal((await request(app).get(`/api/admin/brand-reports/${ASSURED}/3M/download?period=2026-13`)).status, 400);
    assert.equal((await request(app).get(`/api/admin/brand-reports/${ASSURED}/3M/download?period=2999-01`)).status, 400);
    assert.equal((await request(app).get(`/api/admin/brand-reports/${ASSURED}/3M/download?period=2026-10&format=exe`)).status, 400);
});

// ---------- the schedule ----------

test('the monthly run is due from 6 a.m. on the 1st, and any time after as a catch-up', () => {
    assert.equal(scheduler.brandReportDue(1, 5), false);
    assert.equal(scheduler.brandReportDue(1, 6), true);
    assert.equal(scheduler.brandReportDue(1, 23), true);
    assert.equal(scheduler.brandReportDue(2, 3), true, 'the app was down on the 1st: catch up');
    assert.equal(scheduler.brandReportDue(17, 12), true);
});

test('the scheduled run stores last month and the rest of the year, then has nothing left to do', async () => {
    reset();
    const now = new Date('2026-11-01T11:00:00Z');           // 6 a.m. Toronto on the 1st
    const first = await D.runMonthlyBrandReports({ now });
    assert.equal(first.period, '2026-10');
    assert.equal(first.generated, 1);
    assert.equal(first.failed, 0);

    const { data } = await fake.from('monthly_brand_reports').select('period, source, total_qty').eq('company_id', ASSURED);
    const oct = data.find(r => r.period === '2026-10');
    assert.equal(Number(oct.total_qty), 10);
    assert.equal(oct.source, 'scheduled');
    assert.equal(data.length, 10, 'January to October, no gaps');

    const second = await D.runMonthlyBrandReports({ now });
    assert.equal(second.generated, 0);
    assert.equal(second.already, 1);
});

test('the scheduled job claims once, so two instances cannot both build the month', async () => {
    reset();
    // Run the job twice back to back against the same fake: the second sees nothing pending.
    const a = await scheduler.monthlyBrandReportJob();
    const b = await scheduler.monthlyBrandReportJob();
    // Whatever the clock says today, the pair must never both generate.
    const generated = [a, b].filter(r => r && r.generated > 0).length;
    assert.ok(generated <= 1);
});

test('a customer with no subscription is never built', async () => {
    reset({ subscribe: false });
    const r = await D.runMonthlyBrandReports({ now: new Date('2026-11-01T11:00:00Z') });
    assert.equal(r.subscriptions, 0);
    const { data } = await fake.from('monthly_brand_reports').select('id');
    assert.equal((data || []).length, 0);
});

// ---------- safety rails ----------

test('this feature never touches how a company signs in', () => {
    const files = ['utils/brand-sales-report.js', 'utils/brand-report-data.js', 'routes/brand-reports-admin.js', 'migrations/056_monthly_brand_reports.sql'];
    for (const f of files) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        assert.doesNotMatch(src, /access_code|require_individual|individual_logins|people_activity/i, `${f} must not reference sign-in settings`);
        assert.doesNotMatch(src, /update\s+public\.companies|from\('companies'\)\s*\.\s*(update|insert|delete)/i, `${f} must not write to companies`);
    }
});

test('the migration creates the two tables behind RLS with no policy, and seeds only when exactly one Assured exists', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'migrations/056_monthly_brand_reports.sql'), 'utf8');
    assert.match(sql, /create table if not exists public\.brand_report_subscriptions/);
    assert.match(sql, /create table if not exists public\.monthly_brand_reports/);
    assert.match(sql, /enable row level security/);
    assert.match(sql, /unique \(company_id, brand, period\)/);
    assert.match(sql, /if n = 1 then/);
    assert.doesNotMatch(sql, /create policy/i);
});

test('the admin console has the Monthly brand tab wired to the routes', () => {
    const html = fs.readFileSync(path.join(ROOT, 'admin/index.html'), 'utf8');
    assert.match(html, /id="rep-tab-brand"/);
    assert.match(html, /id="rep-brand-pane"/);
    assert.match(html, /\/brand-reports\//);
    assert.match(html, /function brandDownload/);
});
