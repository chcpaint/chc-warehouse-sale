/**
 * tests/rebates.test.js
 *
 * utils/rebates.js: the rebate a company earns on what it buys.
 * The Assured case: 5% of all item dollars spent, accrued monthly.
 *
 *   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const rb = require('../utils/rebates');
const { createFakeSupabase } = require('./helpers/fake-supabase');

const rule = (o) => ({ id: 'rule-' + Math.random().toString(36).slice(2), label: 'Rebate', percent: 5, applies_to: 'all',
    categories: [], brands: [], frequency: 'monthly', starts_on: null, ends_on: null, is_active: true, ...o });
const order = (o) => ({ id: 'o' + Math.random().toString(36).slice(2), status: 'closed', created_at: '2026-09-15T15:00:00Z', items: [], ...o });
const line = (subtotal, o = {}) => ({ product_id: 'p1', subtotal, quantity: 1, unit_price: subtotal, ...o });
const NOW = new Date('2026-10-16T15:00:00Z');

test('5% of all item dollars, grouped by month', () => {
    const r = rb.computeRebates({ now: NOW, rules: [rule({})], orders: [
        order({ created_at: '2026-09-02T15:00:00Z', items: [line(1000)] }),
        order({ created_at: '2026-09-20T15:00:00Z', items: [line(500), line(500)] }),
        order({ created_at: '2026-10-05T15:00:00Z', items: [line(200)] })
    ] });
    assert.equal(r.rows.length, 2);
    const sep = r.rows.find(x => x.period_key === '2026-09');
    assert.equal(sep.eligible_spend, 2000);
    assert.equal(sep.rebate, 100);
    assert.equal(sep.orders, 2);
    assert.equal(sep.complete, true);
    const oct = r.rows.find(x => x.period_key === '2026-10');
    assert.equal(oct.rebate, 10);
    assert.equal(oct.complete, false, 'October is still in progress');
    assert.equal(r.totals.rebate, 110);
    assert.equal(r.totals.eligible_spend, 2200);
});
test('cancelled orders and lines still waiting for a price do not count', () => {
    const r = rb.computeRebates({ now: NOW, rules: [rule({})], orders: [
        order({ status: 'cancelled', items: [line(1000)] }),
        order({ items: [line(100), line(999, { price_on_request: true }), line(0)] })
    ] });
    assert.equal(r.totals.eligible_spend, 100);
    assert.equal(r.totals.rebate, 5);
});
test('tax, delivery fee and fuel surcharge are not in the base (only line subtotals are)', () => {
    const r = rb.computeRebates({ now: NOW, rules: [rule({})], orders: [
        order({ subtotal: 100, tax: 13, delivery_fee: 10, fuel_surcharge: 4, total: 127, items: [line(100)] })
    ] });
    assert.equal(r.totals.eligible_spend, 100);
});
test('selected categories and brands only', () => {
    const items = [
        line(100, { category: 'Primers', brand: 'PPG' }),
        line(200, { category: 'Abrasives', brand: '3M' }),
        line(400, { category: 'Tools', brand: 'Other' })
    ];
    const cat = rb.computeRebates({ now: NOW, rules: [rule({ applies_to: 'selected', categories: ['primers'] })], orders: [order({ items })] });
    assert.equal(cat.totals.eligible_spend, 100, 'category match is not case sensitive');
    const brand = rb.computeRebates({ now: NOW, rules: [rule({ applies_to: 'selected', brands: ['3M'] })], orders: [order({ items })] });
    assert.equal(brand.totals.eligible_spend, 200);
    const both = rb.computeRebates({ now: NOW, rules: [rule({ applies_to: 'selected', brands: ['3M'], categories: ['Primers'] })], orders: [order({ items })] });
    assert.equal(both.totals.eligible_spend, 300, 'a line matching either list counts');
});
test('where two rebates cover an item the higher percent is used, never both', () => {
    const r = rb.computeRebates({ now: NOW, orders: [order({ items: [line(1000, { brand: '3M', category: 'Abrasives' })] })], rules: [
        rule({ label: 'All', percent: 5 }),
        rule({ label: '3M extra', percent: 8, applies_to: 'selected', brands: ['3M'] })
    ] });
    assert.equal(r.totals.rebate, 80);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].label, '3M extra');
});
test('quarterly and annual frequencies bucket correctly', () => {
    const orders = [
        order({ created_at: '2026-07-10T15:00:00Z', items: [line(100)] }),
        order({ created_at: '2026-09-10T15:00:00Z', items: [line(100)] }),
        order({ created_at: '2026-10-10T15:00:00Z', items: [line(100)] })
    ];
    const q = rb.computeRebates({ now: NOW, orders, rules: [rule({ frequency: 'quarterly' })] });
    assert.deepEqual(q.rows.map(x => [x.period_key, x.eligible_spend]).sort(), [['2026-Q3', 200], ['2026-Q4', 100]]);
    const a = rb.computeRebates({ now: NOW, orders, rules: [rule({ frequency: 'annual' })] });
    assert.equal(a.rows.length, 1);
    assert.equal(a.rows[0].period_key, '2026');
    assert.equal(a.rows[0].eligible_spend, 300);
});
test('a late-evening order on the last day of the month stays in that month (Toronto time)', () => {
    // 2026-11-01T03:30Z is 11:30pm on Oct 31 in Toronto.
    const r = rb.computeRebates({ now: NOW, rules: [rule({})], orders: [order({ created_at: '2026-11-01T03:30:00Z', items: [line(100)] })] });
    assert.equal(r.rows[0].period_key, '2026-10');
});
test('start and end dates limit which orders count', () => {
    const orders = [
        order({ created_at: '2026-08-20T15:00:00Z', items: [line(100)] }),
        order({ created_at: '2026-09-20T15:00:00Z', items: [line(100)] }),
        order({ created_at: '2026-10-10T15:00:00Z', items: [line(100)] })
    ];
    const r = rb.computeRebates({ now: NOW, orders, rules: [rule({ starts_on: '2026-09-01', ends_on: '2026-09-30' })] });
    assert.equal(r.totals.eligible_spend, 100);
});
test('a paused rule earns nothing', () => {
    const r = rb.computeRebates({ now: NOW, rules: [rule({ is_active: false })], orders: [order({ items: [line(100)] })] });
    assert.equal(r.rows.length, 0);
});
test('brand/category fall back to the product when the order line predates freezing them', () => {
    const info = new Map([['p1', { brand: '3M', category: 'Abrasives' }]]);
    const r = rb.computeRebates({ now: NOW, itemInfo: info, rules: [rule({ applies_to: 'selected', brands: ['3M'] })], orders: [order({ items: [line(100)] })] });
    assert.equal(r.totals.eligible_spend, 100);
});
test('rounding is to the cent, once per period', () => {
    const r = rb.computeRebates({ now: NOW, rules: [rule({ percent: 5 })], orders: [order({ items: [line(0.33), line(0.33), line(0.33)] })] });
    assert.equal(r.totals.rebate, 0.05);
});

// ---------- validation ----------
test('normalizeRebateRule accepts good input and refuses bad input', () => {
    const ok = rb.normalizeRebateRule({ label: 'Assured rebate', percent: '5', applies_to: 'all', frequency: 'monthly' });
    assert.equal(ok.error, undefined);
    assert.equal(ok.value.percent, 5);
    assert.deepEqual(ok.value.categories, []);
    const bad = (o) => assert.ok(rb.normalizeRebateRule(o).error, JSON.stringify(o));
    bad({ percent: 0 });
    bad({ percent: -1 });
    bad({ percent: 101 });
    bad({ percent: 'x' });
    bad({ percent: 5, applies_to: 'selected' });
    bad({ percent: 5, applies_to: 'everything-ish' });
    bad({ percent: 5, frequency: 'weekly' });
    bad({ percent: 5, starts_on: 'tomorrow' });
    bad({ percent: 5, starts_on: '2026-10-01', ends_on: '2026-09-01' });
});

// ---------- the loader: more than one page of orders ----------
test('rebateReportFor reads every order, not just the first page', async () => {
    const CO = '11111111-1111-4111-8111-111111111111';
    const orders = [];
    for (let i = 0; i < 1500; i++) {
        orders.push({ id: 'ord-' + i, company_id: CO, status: 'closed', location_id: null,
            created_at: '2026-09-15T15:00:00Z', items: [{ product_id: 'p1', subtotal: 10, quantity: 1 }] });
    }
    const fake = createFakeSupabase({
        company_rebate_rules: [{ id: 'r1', company_id: CO, label: 'Assured rebate', percent: 5, applies_to: 'all', categories: [], brands: [], frequency: 'monthly', is_active: true, created_at: '2026-01-01T00:00:00Z' }],
        orders, products: []
    });
    const rep = await rb.rebateReportFor(fake, { companyId: CO, now: NOW });
    assert.equal(rep.totals.eligible_spend, 15000);
    assert.equal(rep.totals.rebate, 750);
});
test('with no rebate rules the report is empty', async () => {
    const fake = createFakeSupabase({ company_rebate_rules: [], orders: [] });
    const rep = await rb.rebateReportFor(fake, { companyId: 'x', now: NOW });
    assert.deepEqual(rep.rows, []);
    assert.equal(rep.totals.rebate, 0);
});
