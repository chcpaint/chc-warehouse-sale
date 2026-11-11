/**
 * tests/accounting-export.test.js -- purchases as bills for QuickBooks Online,
 * Xero or any package. Every bill must add up to the order to the cent.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOptions, buildBills, render, billDate, formatDate, csvCell } = require('../utils/accounting-export');

const opts = (q = {}) => normalizeOptions({ format: 'qbo', ...q }, { supplier: 'CHC Paint & Auto Body Supplies' }).value;
const L = (sku, name, qty, price, brand = 'PPG', extra = {}) => ({ sku, name, brand, quantity: qty, unit_price: price, subtotal: price == null ? null : qty * price, ...extra });
const ORDER = {
    id: 'o1', order_number: 'ASR-1001', status: 'closed', po_number: 'PO-77', location: 'Assured Kanata',
    created_at: '2026-10-01T14:00:00Z',
    status_history: [{ status: 'processing', timestamp: '2026-10-01T15:00:00Z' }, { status: 'out_on_delivery', timestamp: '2026-10-03T04:30:00Z' }, { status: 'closed', timestamp: '2026-10-04T15:00:00Z' }],
    items: [L('T400', 'EHP White 2L', 2, 100), L('BLUEPSL', 'PPG Blue Paint Suit Large', 4, 10), L('MMM02023', '3M Wetordry', 10, 2, '3M'), L('SL93LV', 'OneChoice Accelerator', 1, null, 'PPG', { price_on_request: true })],
    subtotal: 260, tax: 33.8, total: 308.8   // $15 delivery fee on top
};

test('options: defaults, validation, and the supplier is the distributor', () => {
    const o = opts();
    assert.equal(o.supplier, 'CHC Paint & Auto Body Supplies');
    assert.deepEqual(o.accounts, { ppg: 'Paint and Materials', sundries: 'Shop Supplies', fees: 'Freight and Delivery' });
    assert.equal(o.dueDays, 30);
    assert.ok(normalizeOptions({ format: 'sage-xml' }).error);
    assert.ok(normalizeOptions({ format: 'qbo', due_days: '-3' }).error);
});

test('a bill per shipped order, dated the day it shipped (Toronto), lines by account, adding up to the order', () => {
    const { bills, skipped } = buildBills({ orders: [ORDER], itemInfo: new Map(), overrides: new Map(), options: opts() });
    assert.equal(bills.length, 1);
    const b = bills[0];
    assert.equal(b.date, '2026-10-03', 'shipped 12:30 a.m. Toronto on Oct 3');
    assert.equal(b.due, '2026-11-02');
    assert.deepEqual(b.lines.map(l => [l.account, l.amount]), [['Paint and Materials', 200], ['Shop Supplies', 60], ['Freight and Delivery', 15]],
        'paint suits are sundries; the fee is its own line');
    const sum = b.lines.reduce((s, l) => s + l.amount + l.tax, 0);
    assert.equal(Math.round(sum * 100) / 100, 308.8);
    assert.equal(Math.round(b.lines.reduce((s, l) => s + l.tax, 0) * 100) / 100, 33.8);
    assert.equal(b.lines[2].tax, 0);
    assert.equal(b.lines[2].taxCode, 'Exempt');
    assert.equal(skipped.unpriced_lines, 1);
});

test('orders not shipped, and cancelled orders, are not bills', () => {
    const { bills, skipped } = buildBills({
        orders: [{ ...ORDER, id: 'p', status: 'pending' }, { ...ORDER, id: 'c', status: 'cancelled' }, ORDER],
        itemInfo: new Map(), overrides: new Map(), options: opts()
    });
    assert.equal(bills.length, 1);
    assert.deepEqual([skipped.not_shipped, skipped.cancelled], [1, 1]);
});

test('a price change after ordering becomes an adjustment line, so the bill still matches', () => {
    const edited = { ...ORDER, subtotal: 250, tax: 32.5, total: 297.5 };   // $10 discount given later
    const b = buildBills({ orders: [edited], itemInfo: new Map(), overrides: new Map(), options: opts() }).bills[0];
    assert.ok(b.lines.some(l => l.description === 'Order adjustment' && l.amount === -10));
    assert.equal(Math.round(b.lines.reduce((s, l) => s + l.amount + l.tax, 0) * 100) / 100, 297.5);
});

test('one line per item when asked', () => {
    const b = buildBills({ orders: [ORDER], itemInfo: new Map(), overrides: new Map(), options: opts({ detail: 'items' }) }).bills[0];
    assert.equal(b.lines.filter(l => l.account !== 'Freight and Delivery').length, 3);
    assert.ok(b.lines.some(l => /T400 EHP White 2L/.test(l.description) && l.qty === 2));
});

test('QuickBooks Online file: its column names, one row per line, exclusive amounts', () => {
    const o = opts();
    const out = render(buildBills({ orders: [ORDER], itemInfo: new Map(), overrides: new Map(), options: o }), o, 'Assured Oct');
    const lines = out.csv.replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(lines[0], 'Bill No.,Supplier,Bill Date,Due Date,Memo,Account,Line Description,Line Amount,Line Tax Code,Line Tax Amount');
    assert.equal(lines.length, 4);
    assert.match(lines[1], /^ASR-1001,CHC Paint & Auto Body Supplies,03\/10\/2026,02\/11\/2026,PO PO-77 - Assured Kanata,Paint and Materials,PPG paint lines,200\.00,HST ON,/);
    assert.match(out.filename, /^QuickBooks-bills-Assured-Oct\.csv$/);
});

test('Xero file: its template headers and the shop as a tracking option', () => {
    const o = opts({ format: 'xero' });
    const out = render(buildBills({ orders: [ORDER], itemInfo: new Map(), overrides: new Map(), options: o }), o);
    const [head, first] = out.csv.replace(/^﻿/, '').split('\r\n');
    for (const h of ['*ContactName', '*InvoiceNumber', '*InvoiceDate', '*DueDate', '*Quantity', '*UnitAmount', '*AccountCode', '*TaxType', 'TaxAmount', 'TrackingName1', 'TrackingOption1']) {
        assert.ok(head.split(',').includes(h), h);
    }
    const cells = first.split(',');
    const idx = n => head.split(',').indexOf(n);
    assert.equal(cells[idx('TrackingName1')], 'Shop');
    assert.equal(cells[idx('TrackingOption1')], 'Assured Kanata');
    assert.equal(cells[idx('*AccountCode')], 'Paint and Materials');
});

test('dates and spreadsheet safety', () => {
    assert.equal(formatDate('2026-10-03', 'mm/dd/yyyy'), '10/03/2026');
    assert.equal(formatDate('2026-10-03', 'yyyy-mm-dd'), '2026-10-03');
    assert.equal(billDate({ created_at: '2026-10-01T14:00:00Z', status_history: [] }), '2026-10-01');
    assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
    assert.equal(csvCell('-10.00'), '-10.00', 'negative amounts stay numbers');
});

test('both Reports screens offer it, and the shop route refuses accounts with hidden pricing', () => {
    const fs = require('fs'); const path = require('path');
    const store = fs.readFileSync(path.join(__dirname, '../public/store.html'), 'utf8');
    const admin = fs.readFileSync(path.join(__dirname, '../admin/index.html'), 'utf8');
    assert.match(store, /onclick="openAcctExport\(\)"/);
    assert.match(admin, /onclick="openAdminAcctExport\(\)"/);
    const route = fs.readFileSync(path.join(__dirname, '../routes/storefront.js'), 'utf8');
    assert.match(route, /hidePricingEnabled\(settings\)\) return res\.status\(403\)\.json\(\{ error: 'Prices are hidden/);
});
