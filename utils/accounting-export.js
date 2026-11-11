/**
 * utils/accounting-export.js -- a shop's purchases as supplier bills its
 * accounting software can import.
 *
 * Formats:
 *   qbo   QuickBooks Online "Import bills" CSV: Bill no., Supplier, Bill Date,
 *         Due Date, Memo, Account, Line Description, Line Amount, Line Tax Code,
 *         Line Tax Amount (amounts exclusive of tax; choose "Exclusive" when
 *         mapping). QuickBooks asks you to map your tax code names and
 *         recommends up to 100 bills per import.
 *   xero  Xero bill (purchases) import CSV, with the shop as tracking category
 *         "Shop" so multi-shop owners can report by shop in Xero.
 *   csv   One line per account per order with tax and totals, for Sage and
 *         anything else.
 *
 * One bill per order, dated the day it shipped (status history), else the order
 * date; only orders that have shipped (Out for delivery or Closed) are bills.
 * Lines are grouped by account: PPG paint lines, sundries (utils/report-groups.js)
 * and delivery / fuel fees; or one line per item. Tax is the order's own tax,
 * spread over the item lines in proportion to their amounts; fees carry none
 * (the console does not tax them). Every bill adds up to the order total to the
 * cent. Lines still "price on request" are left out and counted.
 *
 * Pure functions; the routes load the orders.
 */
const { classify } = require('./report-groups');
const { torontoParts } = require('./brand-sales-report');

const SHIPPED = new Set(['out_on_delivery', 'closed']);
const FORMATS = ['qbo', 'xero', 'csv'];
const DATE_FORMATS = ['dd/mm/yyyy', 'mm/dd/yyyy', 'yyyy-mm-dd'];
const cents = n => Math.round((Number(n) || 0) * 100) / 100;
const clean = (v, max = 120) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Options from a request, cleaned, with defaults. Returns { value } or { error }. */
function normalizeOptions(q, defaults = {}) {
    const format = FORMATS.includes(q.format) ? q.format : null;
    if (!format) return { error: 'Choose QuickBooks Online, Xero or CSV.' };
    const dateFormat = DATE_FORMATS.includes(q.date_format) ? q.date_format : 'dd/mm/yyyy';
    const due = q.due_days === undefined || q.due_days === '' ? 30 : Number(q.due_days);
    if (!Number.isInteger(due) || due < 0 || due > 365) return { error: 'Payment terms must be 0 to 365 days.' };
    const v = {
        format,
        detail: q.detail === 'items' ? 'items' : 'summary',
        supplier: clean(q.supplier || defaults.supplier || 'CHC Paint & Auto Body Supplies', 100),
        accounts: {
            ppg: clean(q.ppg_account || 'Paint and Materials', 100),
            sundries: clean(q.sundries_account || 'Shop Supplies', 100),
            fees: clean(q.fees_account || 'Freight and Delivery', 100)
        },
        taxCode: clean(q.tax_code || 'HST ON', 40),
        feesTaxCode: clean(q.fees_tax_code || 'Exempt', 40),
        dueDays: due,
        dateFormat
    };
    if (!v.accounts.ppg || !v.accounts.sundries || !v.accounts.fees) return { error: 'Name an account for PPG paint, sundries and fees.' };
    return { value: v };
}

function formatDate(isoDate, fmt) {
    const [y, m, d] = isoDate.split('-');
    if (fmt === 'mm/dd/yyyy') return `${m}/${d}/${y}`;
    if (fmt === 'yyyy-mm-dd') return isoDate;
    return `${d}/${m}/${y}`;
}
function addDays(isoDate, days) {
    const t = new Date(isoDate + 'T12:00:00Z');
    t.setUTCDate(t.getUTCDate() + days);
    return t.toISOString().slice(0, 10);
}

/** The day an order first shipped (Toronto), else its order date. */
function billDate(o) {
    const hist = (Array.isArray(o.status_history) ? o.status_history : [])
        .filter(h => h && SHIPPED.has(h.status) && h.timestamp)
        .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    const t = torontoParts((hist[0] && hist[0].timestamp) || o.created_at);
    return t ? t.date : null;
}

const qtyOf = l => { const q = Number(l.quantity != null ? l.quantity : l.qty); return Number.isFinite(q) && q > 0 ? q : 0; };
function lineAmount(l) {
    if (l.price_on_request === true) return null;
    if (l.subtotal != null && l.subtotal !== '' && Number.isFinite(Number(l.subtotal))) return Number(l.subtotal);
    const p = Number(l.unit_price != null ? l.unit_price : l.price);
    return Number.isFinite(p) && p > 0 ? p * qtyOf(l) : null;
}

/**
 * Orders -> bills.
 * Returns { bills: [{ number, date, due, po, shop, memo, total, lines: [{ account, kind, description, qty, unit, amount, tax, taxCode }] }],
 *           skipped: { not_shipped, cancelled, unpriced_lines } }
 */
function buildBills({ orders, itemInfo, overrides, options }) {
    const o = options;
    const bills = [];
    const skipped = { not_shipped: 0, cancelled: 0, unpriced_lines: 0 };
    for (const ord of orders || []) {
        if (!ord) continue;
        if (ord.status === 'cancelled') { skipped.cancelled += 1; continue; }
        if (!SHIPPED.has(ord.status)) { skipped.not_shipped += 1; continue; }
        const date = billDate(ord);
        if (!date) continue;

        const items = [];
        for (const l of Array.isArray(ord.items) ? ord.items : []) {
            const qty = qtyOf(l);
            if (!qty) continue;
            const amt = lineAmount(l);
            if (amt == null) { skipped.unpriced_lines += 1; continue; }
            const known = (itemInfo && itemInfo.get && itemInfo.get(l.product_id)) || {};
            const g = classify({ brand: l.brand || known.brand, category: l.category || known.category, name: l.name, sku: l.sku }, overrides).group;
            items.push({ kind: g, account: g === 'ppg' ? o.accounts.ppg : o.accounts.sundries, sku: l.sku || '', name: l.name || '', qty, amount: cents(amt) });
        }

        let lines;
        if (o.detail === 'items') {
            lines = items.map(i => ({ account: i.account, kind: i.kind, description: clean(`${i.sku ? i.sku + ' ' : ''}${i.name}`, 200), qty: i.qty, amount: i.amount }));
        } else {
            const by = new Map();
            for (const i of items) {
                const b = by.get(i.kind) || { account: i.account, kind: i.kind, description: i.kind === 'ppg' ? 'PPG paint lines' : 'Sundries', qty: 1, amount: 0 };
                b.amount = cents(b.amount + i.amount);
                by.set(i.kind, b);
            }
            lines = ['ppg', 'sundries'].filter(k => by.has(k)).map(k => by.get(k));
        }

        // Match the order exactly: subtotal adjustments (price edits, promotions
        // applied after the fact) and fees.
        const subtotal = ord.subtotal != null ? cents(ord.subtotal) : cents(items.reduce((s, i) => s + i.amount, 0));
        const itemSum = cents(lines.reduce((s, l) => s + l.amount, 0));
        if (Math.abs(subtotal - itemSum) >= 0.01) {
            lines.push({ account: o.accounts.sundries, kind: 'sundries', description: 'Order adjustment', qty: 1, amount: cents(subtotal - itemSum) });
        }
        const tax = cents(ord.tax);
        const total = ord.total != null ? cents(ord.total) : cents(subtotal + tax);
        const fees = cents(total - subtotal - tax);

        // Spread the tax over item lines by amount; the last line takes the rounding.
        const taxable = lines.filter(l => l.amount > 0);
        const base = taxable.reduce((s, l) => s + l.amount, 0);
        let given = 0;
        for (const l of lines) { l.tax = 0; l.taxCode = o.taxCode; }
        taxable.forEach((l, i) => {
            l.tax = i === taxable.length - 1 ? cents(tax - given) : cents(base ? tax * l.amount / base : 0);
            given = cents(given + l.tax);
        });
        if (!taxable.length && tax) lines.push({ account: o.accounts.sundries, kind: 'sundries', description: 'Tax', qty: 1, amount: 0, tax, taxCode: o.taxCode });
        if (Math.abs(fees) >= 0.01) {
            lines.push({ account: o.accounts.fees, kind: 'fees', description: 'Delivery and fuel surcharge', qty: 1, amount: fees, tax: 0, taxCode: o.feesTaxCode });
        }
        if (!lines.length) continue;

        bills.push({
            number: clean(ord.order_number, 40), date, due: addDays(date, o.dueDays), po: clean(ord.po_number, 60),
            shop: clean(ord.location || 'Unassigned', 100),
            memo: clean([ord.po_number ? `PO ${ord.po_number}` : '', ord.location || ''].filter(Boolean).join(' - '), 200),
            total, lines
        });
    }
    bills.sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
    return { bills, skipped };
}

function csvCell(v) {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;   // never let a spreadsheet run a formula
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const money = n => cents(n).toFixed(2);

/** Bills -> the chosen file. Returns { filename, csv }. */
function render(result, o, label = 'export') {
    const rows = [];
    const d = s => formatDate(s, o.dateFormat);
    if (o.format === 'qbo') {
        rows.push(['Bill No.', 'Supplier', 'Bill Date', 'Due Date', 'Memo', 'Account', 'Line Description', 'Line Amount', 'Line Tax Code', 'Line Tax Amount']);
        for (const b of result.bills) for (const l of b.lines) {
            rows.push([b.number, o.supplier, d(b.date), d(b.due), b.memo, l.account, l.qty > 1 && o.detail === 'items' ? `${l.description} (x${l.qty})` : l.description, money(l.amount), l.taxCode, money(l.tax)]);
        }
    } else if (o.format === 'xero') {
        rows.push(['*ContactName', 'EmailAddress', 'POAddressLine1', 'POAddressLine2', 'POAddressLine3', 'POAddressLine4', 'POCity', 'PORegion', 'POPostalCode', 'POCountry',
            '*InvoiceNumber', '*InvoiceDate', '*DueDate', 'Total', 'InventoryItemCode', 'Description', '*Quantity', '*UnitAmount', '*AccountCode', '*TaxType', 'TaxAmount',
            'TrackingName1', 'TrackingOption1', 'TrackingName2', 'TrackingOption2', 'Currency']);
        for (const b of result.bills) for (const l of b.lines) {
            const qty = o.detail === 'items' ? l.qty : 1;
            rows.push([o.supplier, '', '', '', '', '', '', '', '', '', b.number, d(b.date), d(b.due), money(b.total), '',
                l.description + (b.po ? ` (PO ${b.po})` : ''), qty, qty === 1 ? money(l.amount) : (l.amount / qty).toFixed(4), l.account, l.taxCode, money(l.tax),
                'Shop', b.shop, '', '', '']);
        }
    } else {
        rows.push(['Bill date', 'Due date', 'Supplier', 'Bill no.', 'PO', 'Shop', 'Account', 'Description', 'Quantity', 'Amount', 'Tax', 'Line total', 'Tax code']);
        for (const b of result.bills) for (const l of b.lines) {
            rows.push([d(b.date), d(b.due), o.supplier, b.number, b.po, b.shop, l.account, l.description, l.qty, money(l.amount), money(l.tax), money(l.amount + l.tax), l.taxCode]);
        }
    }
    const name = { qbo: 'QuickBooks-bills', xero: 'Xero-bills', csv: 'bills' }[o.format];
    return { filename: `${name}-${String(label).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'export'}.csv`, csv: '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n' };
}

/** Load a company's orders for the export (paged; never silently capped). */
async function loadOrdersForExport(supabase, { companyId, locationId, from, to }) {
    const PAGE = 1000, out = [];
    for (let start = 0; start < 100000; start += PAGE) {
        let q = supabase.from('orders')
            .select('id, order_number, status, status_history, created_at, location, location_id, po_number, subtotal, tax, total, items')
            .eq('company_id', companyId).order('created_at', { ascending: true }).order('id', { ascending: true }).range(start, start + PAGE - 1);
        if (locationId) q = q.eq('location_id', locationId);
        if (from) q = q.gte('created_at', from);
        if (to) q = q.lte('created_at', to);
        const { data, error } = await q;
        if (error) throw error;
        out.push(...(data || []));
        if (!data || data.length < PAGE) return out;
    }
    throw new Error('Too many orders for one export. Narrow the dates.');
}

/** Everything a route needs: load, build, render. */
async function accountingExportFor(supabase, { companyId, locationId, from, to, options, label }) {
    const { loadItemInfo } = require('./rebates');
    const { loadOverrides } = require('./report-groups');
    const orders = await loadOrdersForExport(supabase, { companyId, locationId, from, to });
    const [itemInfo, overrides] = await Promise.all([loadItemInfo(supabase, companyId, orders), loadOverrides(supabase)]);
    const result = buildBills({ orders, itemInfo, overrides, options });
    return { ...render(result, options, label), bills: result.bills.length, skipped: result.skipped };
}

module.exports = { FORMATS, DATE_FORMATS, normalizeOptions, buildBills, render, billDate, formatDate, accountingExportFor, csvCell };
