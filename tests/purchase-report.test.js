/**
 * tests/purchase-report.test.js -- the Purchase report PDF's numbers.
 *
 * Asked for: a company's purchases by location, by order and by item, all in
 * one PDF (Assured first; any company can use it). CSV downloads unchanged.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildPurchaseReport } = require('../public/purchase-report');

const ROOT = path.resolve(__dirname, '..');
const L = (sku, name, q, price, extra = {}) => ({ sku, name, quantity: q, unit_price: price, subtotal: price == null ? null : q * price, ...extra });
const ORDERS = [
    { id: 'a', order_number: 'ASR-1', created_at: '2026-10-02T14:00:00Z', status: 'closed', location: 'Assured Kanata', po_number: '', contact_name: 'Pat',
      tax: 26, total: 226, items: [L('MMM02023', '3M Wetordry P1500', 10, 10), L('T400', 'EHP White 2L', 1, 100)] },
    { id: 'b', order_number: 'ASR-2', created_at: '2026-10-05T14:00:00Z', status: 'out_on_delivery', status_label: 'Out for Delivery', location: 'Assured Orleans', po_number: 'PO-7', contact_name: 'Sam',
      tax: 13, total: 113, items: [L('MMM02023', '3M Wetordry P1500', 5, 10), L('SL93LV', 'OneChoice Accelerator', 2, null, { price_on_request: true }), L('SEM1', 'SEM Black', 1, 50)] },
    { id: 'c', order_number: 'ASR-3', created_at: '2026-10-06T14:00:00Z', status: 'cancelled', location: 'Assured Kanata', tax: 0, total: 999,
      items: [L('T400', 'EHP White 2L', 9, 111)] }
];

test('summary, locations, orders and items add up; cancelled orders are left out and counted', () => {
    const r = buildPurchaseReport(ORDERS);
    assert.equal(r.cancelled_excluded, 1);
    assert.deepEqual(r.summary, { orders: 2, units: 19, unique_items: 4, shops: 2, item_dollars: 300, tax: 39, total: 339, unpriced_units: 2 });

    assert.deepEqual(r.locations.map(l => [l.location, l.orders, l.units, l.item_dollars, l.total]),
        [['Assured Kanata', 1, 11, 200, 226], ['Assured Orleans', 1, 8, 100, 113]]);

    assert.deepEqual(r.orders.map(o => [o.order_number, o.status, o.units, o.item_dollars, o.total]),
        [['ASR-1', 'Closed', 11, 200, 226], ['ASR-2', 'Out for Delivery', 8, 100, 113]]);

    const wet = r.items.find(i => i.sku === 'MMM02023');
    assert.deepEqual([wet.units, wet.orders, wet.shops, wet.dollars, wet.avg_price], [15, 2, 2, 150, 10]);
    const acc = r.items.find(i => i.sku === 'SL93LV');
    assert.equal(acc.avg_price, null, 'never priced: no average price invented');

    assert.deepEqual(r.items_by_location.map(g => g.location), ['Assured Kanata', 'Assured Orleans']);
    assert.deepEqual(r.items_by_location[1].items.map(i => i.sku), ['MMM02023', 'SEM1', 'SL93LV'], 'dollars, then units');
});

test('an item filter narrows every section and drops order totals that would no longer match', () => {
    const r = buildPurchaseReport(ORDERS, { itemTerm: 'wetordry' });
    assert.equal(r.item_filter, 'wetordry');
    assert.equal(r.summary.orders, 2);
    assert.equal(r.summary.item_dollars, 150);
    assert.equal(r.summary.total, null);
    assert.deepEqual(r.items.map(i => i.sku), ['MMM02023']);
    assert.ok(r.orders.every(o => o.total === null));
});

test('several companies (CHC console, All companies): shops are named with their company', () => {
    const r = buildPurchaseReport([{ ...ORDERS[0], company_name: 'Assured' }, { ...ORDERS[1], company_name: "Louie's", location: 'York Mills' }]);
    assert.equal(r.multi_company, true);
    assert.deepEqual(r.locations.map(l => l.location).sort(), ["Assured - Assured Kanata", "Louie's - York Mills"]);
});

test('a company that hides pricing is flagged so the PDF shows units only', () => {
    const hidden = ORDERS.map(o => ({ ...o, total: null, tax: null, pricing_hidden: true, items: o.items.map(l => ({ ...l, unit_price: null, subtotal: null })) }));
    const r = buildPurchaseReport(hidden);
    assert.equal(r.hide_pricing, true);
    assert.equal(r.summary.item_dollars, 0);
    assert.equal(r.summary.units, 19);
});

test('both consoles offer the Purchase report PDF and keep their CSV buttons', () => {
    const store = fs.readFileSync(path.join(ROOT, 'public/store.html'), 'utf8');
    const admin = fs.readFileSync(path.join(ROOT, 'admin/index.html'), 'utf8');
    for (const html of [store, admin]) {
        assert.match(html, /Purchase report PDF<\/button>/);
        assert.match(html, /<script src="\/purchase-report\.js"><\/script>/);
        assert.match(html, /PurchaseReport\.buildPurchaseReport\(/);
        assert.match(html, /Orders CSV<\/button>/);
        assert.ok(!/Summary PDF<\/button>/.test(html));
    }
    const js = fs.readFileSync(path.join(ROOT, 'public/purchase-report.js'), 'utf8');
    for (const t of ["section('By location')", "section('By order')", "section('By item'", "section('Items by location')"]) assert.ok(js.includes(t), t);
    assert.ok(!/\bfetch\(/.test(js), 'builds from what the screen already loaded; no extra requests');
});
