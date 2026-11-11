/**
 * tests/report-groups.test.js -- PPG paint lines vs sundries.
 *
 * What CHC asked for: split purchases into PPG lines (Envirobase / EHP,
 * Shopline, OneChoice, Delfleet Essential, Omni, any PPG line) and sundries
 * (the rest), by item, dollars and time, per shop within a customer. PPG paint
 * suits and other general, non-paint items are sundries, for reports and for
 * rebates.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const { createFakeSupabase } = require('./helpers/fake-supabase');
const G = require('../utils/report-groups');
const { computeRebates, normalizeRebateRule } = require('../utils/rebates');

const ROOT = path.resolve(__dirname, '..');
const none = new Map();
const group = (brand, name, extra = {}) => G.classify({ brand, name, ...extra }, none);

test('PPG paint lines are PPG, named by line', () => {
    const cases = [
        ['PPG', 'EHP White 2L', 'T400', 'Envirobase / EHP'],
        ['Other', 'PPG Envirobase HP Purple Fantasy Toner T4032', 'T4032', 'Envirobase / EHP'],
        ['PPG', 'Shop-Line 2.1 VOC Production Clear Ga', 'JC830', 'Shopline'],
        ['PPG', 'Shop-Line Medium Aluminum Ga', 'J70', 'Shopline'],
        ['PPG', 'OneChoice Low VOC Accelerator', 'SL93LV', 'OneChoice'],
        ['One Choice', 'Primer', 'SU470LV', 'OneChoice'],
        ['PPG', '* Delfleet Essential Basecoat Converter Qt', 'ESB800', 'Delfleet'],
        ['PPG', 'Deltron Medium Reducer', 'DT1850', 'Deltron'],
        ['Omni', 'Omni Clear', 'MC260', 'Omni'],
        ['PPG', 'EuroPlus Multi-Panel Clearcoat', 'X1', 'Other PPG'],
        ['PPG', '2.1 Voc White Epoxy Primer', 'CRE-121', 'Other PPG'],
        ['PPG', 'Ceramiclear Hardner 1Pint', 'D8226', 'Other PPG'],
        ['PPG', 'OneChoice Waterborne Gun Cleaner 5Ga', 'SX1', 'OneChoice'],
        ['PPG', 'Primer', 'DP48LV', 'Deltron']
    ];
    for (const [brand, name, sku, line] of cases) {
        const c = G.classify({ brand, name, sku }, none);
        assert.equal(c.group, 'ppg', name);
        assert.equal(c.line, line, name);
    }
});

test('PPG general items that are not paint are sundries', () => {
    const general = [
        ['PPG', 'PPG Blue Paint Suit Large', 'Masks/Suits'],
        ['PPG', 'Two piece Paint Suit Large', null],
        ['PPG', 'PPG White Masking Paper 18 x 750 2/PK', 'Abrasives/Masking'],
        ['PPG', 'PPG 32Oz Mixing Cups', 'PPS/Cans'],
        ['PPG', 'Quart Can w/Lid / 56 per box', null],
        ['PPG', 'PPG Disposable Mixing Sticks (500/bx)', null],
        ['PPG', 'G3 Light Gray Sprayout Cards', null],
        ['PPG', 'Test Panel G1 Color', null],
        ['PPG', 'Dell Computer', 'Equip/Filter/Booth'],
        ['PPG', 'PPG Single Edge Razor Blades 100/pk', null],
        ['PPG', 'PPG painter Hats', null],
        ['PPG', 'OneChoice Blue Tack Rag', 'Polish/Comp/Soap'],
        ['PPG', 'Stand Alone Mixing Table', null]
    ];
    for (const [brand, name, category] of general) {
        const c = group(brand, name, { category });
        assert.equal(c.group, 'sundries', name);
        assert.equal(c.reason, 'PPG general item, not paint', name);
    }
});

test('other brands are sundries; similar words do not make an item PPG', () => {
    assert.equal(group('3M', '3M Wetordry P1500').group, 'sundries');
    assert.equal(group('SEM', 'SEM environmental primer').group, 'sundries');
    assert.equal(group('Norton', 'Omnidirectional sanding pad').group, 'sundries');
    assert.equal(group('PPG', 'EHP Standard Undercoat Hardener Qt').group, 'ppg', '"Standard" is not "stand"');
});

test('a CHC correction wins either way, matched however the part number is written', () => {
    const o = new Map([['JC83001', 'sundries'], ['BLUEPSL', 'ppg']]);
    assert.equal(G.classify({ brand: 'PPG', name: 'Shop-Line clear', sku: 'jc830/01' }, o).group, 'sundries');
    const fixed = G.classify({ brand: 'PPG', name: 'PPG Blue Paint Suit', sku: 'BLUEPSL' }, o);
    assert.equal(fixed.group, 'ppg');
    assert.equal(fixed.reason, 'Set by CHC');
});

// ------------------------------------------------------------------
// The split: Louie's, two shops, two months.
// ------------------------------------------------------------------
const YM = '11111111-1111-4111-8111-111111111111';
const N7 = '22222222-2222-4222-8222-222222222222';
const L = (sku, name, qty, price, brand = 'PPG', extra = {}) => ({ sku, name, brand, quantity: qty, unit_price: price, subtotal: price == null ? null : qty * price, ...extra });
const ORDERS = [
    { id: 'o1', status: 'closed', created_at: '2026-09-10T15:00:00Z', location: 'York Mills', location_id: YM,
      items: [L('T400', 'EHP White 2L', 2, 100), L('BLUEPSL', 'PPG Blue Paint Suit Large', 4, 10), L('MMM02023', '3M Wetordry', 10, 2, '3M')] },
    { id: 'o2', status: 'out_on_delivery', created_at: '2026-10-02T15:00:00Z', location: 'North Seven', location_id: N7,
      items: [L('JC830', 'Shop-Line Production Clear Ga', 1, 150), L('SL93LV', 'OneChoice Low VOC Accelerator', 1, null, 'PPG', { price_on_request: true })] },
    { id: 'o3', status: 'cancelled', created_at: '2026-10-03T15:00:00Z', location: 'North Seven', location_id: N7,
      items: [L('T400', 'EHP White 2L', 50, 100)] },
    { id: 'o4', status: 'pending', created_at: '2026-10-31T23:30:00-04:00', location: 'York Mills', location_id: YM,
      items: [L('DOX112', 'PPG Disposable Mixing Sticks (500/bx)', 1, 30)] }
];

test('totals, shares, shops and months add up; cancelled orders are left out', () => {
    const r = G.buildSplit({ orders: ORDERS, itemInfo: new Map(), overrides: none });
    assert.equal(r.orders, 3);
    assert.equal(r.totals.ppg.amount, 350);        // 200 EHP + 150 Shopline
    assert.equal(r.totals.sundries.amount, 90);    // 40 suits + 20 3M + 30 sticks
    assert.equal(r.totals.total.amount, 440);
    assert.equal(r.totals.ppg.share, 79.5);
    assert.equal(r.totals.ppg.unpriced_qty, 1, 'the unpriced accelerator counts its unit, not dollars');

    const ym = r.shops.find(s => s.location === 'York Mills');
    const n7 = r.shops.find(s => s.location === 'North Seven');
    assert.deepEqual([ym.ppg.amount, ym.sundries.amount, ym.total.amount], [200, 90, 290]);
    assert.deepEqual([n7.ppg.amount, n7.sundries.amount, n7.total.amount], [150, 0, 150]);

    assert.deepEqual(r.months.map(m => m.period), ['2026-09', '2026-10'], 'Oct 31 11:30 p.m. Toronto is October');
    const oct = r.months.find(m => m.period === '2026-10');
    assert.equal(oct.ppg.amount, 150);
    assert.equal(oct.sundries.amount, 30);
    assert.equal(r.shop_months.length, 3);

    const suit = r.items.find(i => i.sku === 'BLUEPSL');
    assert.equal(suit.group, 'sundries');
    assert.deepEqual(suit.shops, ['York Mills']);
    assert.deepEqual(r.ppg_lines.map(l => l.line), ['Envirobase / EHP', 'Shopline', 'OneChoice']);
});

test('lines that did not freeze a brand use the product\'s brand', () => {
    const orders = [{ id: 'x', status: 'closed', created_at: '2026-09-10T15:00:00Z', location: 'A', location_id: YM,
        items: [{ product_id: 'p1', sku: 'J70', name: 'Medium Aluminum Ga', quantity: 1, subtotal: 80 }] }];
    const info = new Map([['p1', { brand: 'PPG', category: 'Colour' }]]);
    assert.equal(G.buildSplit({ orders, itemInfo: info, overrides: none }).totals.ppg.amount, 80);
    assert.equal(G.buildSplit({ orders, itemInfo: new Map(), overrides: none }).totals.sundries.amount, 80, 'without the brand it cannot be shown to be PPG');
});

test('a shop that hides pricing gets units, never dollars', () => {
    const r = G.stripDollars(G.buildSplit({ orders: ORDERS, itemInfo: new Map(), overrides: none }));
    const text = JSON.stringify(r);
    assert.ok(!/"amount"|"share"/.test(text));
    assert.equal(r.pricing_hidden, true);
    assert.equal(r.totals.ppg.qty, 4);
});

// ------------------------------------------------------------------
// Rebates on PPG paint only leave paint suits out.
// ------------------------------------------------------------------
test('rebate scopes: PPG paint lines only, and sundries only', () => {
    assert.equal(normalizeRebateRule({ percent: 5, applies_to: 'ppg_paint' }).value.applies_to, 'ppg_paint');
    assert.equal(normalizeRebateRule({ percent: 5, applies_to: 'sundries' }).value.applies_to, 'sundries');
    assert.ok(normalizeRebateRule({ percent: 5, applies_to: 'bogus' }).error);
    const now = new Date('2026-11-11T12:00:00Z');
    const ppg = computeRebates({ orders: ORDERS, rules: [{ id: 'r', label: 'PPG', percent: 10, applies_to: 'ppg_paint', frequency: 'annual' }], itemInfo: new Map(), overrides: none, now });
    assert.equal(ppg.totals.eligible_spend, 350);
    assert.equal(ppg.totals.rebate, 35);
    const sun = computeRebates({ orders: ORDERS, rules: [{ id: 's', label: 'Sundries', percent: 2, applies_to: 'sundries', frequency: 'annual' }], itemInfo: new Map(), overrides: none, now });
    assert.equal(sun.totals.eligible_spend, 90);
    const all = computeRebates({ orders: ORDERS, rules: [{ id: 'a', label: 'All', percent: 5, applies_to: 'all', frequency: 'monthly' }], itemInfo: new Map(), now });
    assert.equal(all.totals.eligible_spend, 440, 'an "all items" rebate (Assured) is unchanged');
});

test('migration 063 adds the corrections table and the two rebate scopes, and nothing else', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'migrations/063_report_item_groups.sql'), 'utf8');
    assert.match(sql, /create table if not exists public\.report_item_groups/);
    assert.match(sql, /enable row level security/);
    assert.match(sql, /'all', 'selected', 'ppg_paint', 'sundries'/);
    assert.match(sql, /applies_to <> 'selected' or cardinality\(categories\) > 0/);
    assert.ok(!/\b(update|delete from|drop table|truncate)\b/i.test(sql.replace(/--.*$/gm, '')), 'no data changes');
});

// ------------------------------------------------------------------
// The shop route, end to end, with the real storefront router.
// ------------------------------------------------------------------
const CO = '33333333-3333-4333-8333-333333333333';
let fake;
const supabaseProxy = new Proxy({}, { get: (_t, prop) => { const v = fake[prop]; return typeof v === 'function' ? v.bind(fake) : v; } });
const stubs = {
    [path.join(ROOT, 'utils/supabase.js')]: { supabaseAdmin: supabaseProxy, supabase: supabaseProxy },
    // Every other auth middleware the storefront imports is a pass-through here.
    [path.join(ROOT, 'middleware/auth.js')]: new Proxy({
        requireCompanyAuth: (req, res, next) => {
            req.company = { id: CO, slug: 'louies' };
            const u = req.headers['x-test-user'];
            req.companyUser = u ? { id: 'u1', location_id: u === 'locked' ? N7 : null } : null;
            next();
        }
    }, { get: (t, k) => (k in t ? t[k] : (req, res, next) => next()) })
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (parent && request.startsWith('.')) {
        const resolved = path.resolve(path.dirname(parent.filename), request);
        for (const key of Object.keys(stubs)) if (key === resolved || key === resolved + '.js') return stubs[key];
    }
    return originalLoad.call(this, request, parent, isMain);
};
for (const k of Object.keys(require.cache)) if (/routes[\\/]storefront\.js$/.test(k)) delete require.cache[k];
const express = require('express');
const request = require('supertest');
const storefront = require('../routes/storefront');
Module._load = originalLoad;
const app = express();
app.use(express.json());
app.use('/api/store', storefront);

function seed(settings, overrides = []) {
    fake = createFakeSupabase({
        companies: [{ id: CO, name: "Louie's", slug: 'louies', is_active: true, settings }],
        orders: ORDERS.map(o => ({ ...o, company_id: CO })),
        report_item_groups: overrides
    });
}

test('route: owners get the split per shop; a correction applies', async () => {
    seed({});
    let r = await request(app).get('/api/store/louies/reports/ppg-split');
    assert.equal(r.status, 200);
    assert.equal(r.body.totals.ppg.amount, 350);
    assert.equal(r.body.shops.length, 2);
    assert.match(r.body.basis, /paint suits/);

    seed({}, [{ sku_key: 'BLUEPSL', sku: 'BLUEPSL', report_group: 'ppg' }]);
    r = await request(app).get('/api/store/louies/reports/ppg-split');
    assert.equal(r.body.totals.ppg.amount, 390);
});

test('route: a person tied to one shop sees only that shop, whatever they ask for', async () => {
    seed({});
    const r = await request(app).get(`/api/store/louies/reports/ppg-split?location_id=${YM}`).set('x-test-user', 'locked');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.shops.map(s => s.location), ['North Seven']);
});

test('route: restricted reports refuse the shared code; hidden pricing gets units only; bad input is refused', async () => {
    seed({ users: { enabled: true }, restricted_reports: { enabled: true } });
    let r = await request(app).get('/api/store/louies/reports/ppg-split');
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'reports_need_account');

    seed({ hide_pricing: { enabled: true } });
    r = await request(app).get('/api/store/louies/reports/ppg-split');
    assert.equal(r.status, 200);
    assert.equal(r.body.pricing_hidden, true);
    assert.ok(!/"amount"|"share"/.test(JSON.stringify(r.body)));

    seed({});
    r = await request(app).get('/api/store/louies/reports/ppg-split?from=drop%20table');
    assert.equal(r.status, 400);
    r = await request(app).get('/api/store/louies/reports/ppg-split?location_id=not-a-uuid');
    assert.equal(r.status, 400);
});

test('the shop Reports screen and the CHC console both show the card', () => {
    const store = fs.readFileSync(path.join(ROOT, 'public/store.html'), 'utf8');
    const admin = fs.readFileSync(path.join(ROOT, 'admin/index.html'), 'utf8');
    assert.match(store, /<div id="ppg-split"/);
    assert.match(store, /window\.PPGS\.loadStore\(params, label\)/);
    assert.match(store, /<script src="\/ppg-split\.js"><\/script>/);
    assert.match(admin, /id="rep-tab-ppg"/);
    assert.match(admin, /<script src="\/ppg-split\.js"><\/script>/);
    assert.match(admin, /value="ppg_paint"/);
    const js = fs.readFileSync(path.join(ROOT, 'public/ppg-split.js'), 'utf8');
    assert.match(js, /const esc = /);
});
