/**
 * utils/brand-sales-report.js
 *
 * The monthly brand sales report: how much of one brand (3M, to start) a
 * customer (Assured, to start) bought in a calendar month -- quantity, dollars
 * and an item-by-item breakdown -- and the year to date that rolls up from the
 * months before it.
 *
 * WHAT COUNTS AS A SALE
 *
 * A line counts when it SHIPPED, not when it was ordered:
 *
 *   - Only orders that are Out for Delivery or Closed. Pending and Cancelled
 *     orders are never in the numbers, so the report matches what was invoiced.
 *   - Each shipment is dated by the moment staff recorded it, read from the
 *     order's status history, in Toronto time. An order placed on the 30th and
 *     shipped on the 2nd is next month's sale.
 *   - Partial shipments are counted for what actually went out. An order that
 *     shipped short with a backorder counts the shipped quantity in the month
 *     it shipped, and the backordered quantity in the month it later ships --
 *     never before it has left the building, and never twice.
 *   - Dollars are quantity x the price on the order, before tax, delivery fees
 *     and fuel surcharge. A line still "price on request" has no price, so its
 *     quantity is counted and its dollars are not; the report says how many
 *     units that is rather than quietly understating the total.
 *
 * Because every month is frozen into a snapshot when it is made (see
 * migrations/056), a past month never moves, and the year to date is just the
 * snapshots added together.
 *
 * Pure functions here take plain data and return plain data; the loading and
 * storing lives at the bottom, so the arithmetic can be tested without a
 * database.
 */

const XLSX = require('xlsx');
const PDFDocument = require('pdfkit');

const TZ = 'America/Toronto';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHIPPED_STATUSES = ['out_on_delivery', 'closed'];

const BASIS_TEXT = 'Quantity shipped (orders Out for Delivery or Closed), dated when it shipped, in Toronto time. ' +
    'Dollars are before tax, delivery fees and fuel surcharge. Pending and cancelled orders are not included.';

const tzFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false
});

/** Toronto calendar parts for a timestamp, or null if it is not a date. */
function torontoParts(ts) {
    const d = ts instanceof Date ? ts : new Date(ts);
    if (!ts || Number.isNaN(d.getTime())) return null;
    const p = Object.fromEntries(tzFmt.formatToParts(d).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
    return { y: Number(p.year), m: Number(p.month), d: Number(p.day), date: `${p.year}-${p.month}-${p.day}`, period: `${p.year}-${p.month}` };
}

const pad2 = n => String(n).padStart(2, '0');
const cents = n => Math.round((Number(n) || 0) * 100) / 100;
const fold = s => String(s == null ? '' : s).trim().toLowerCase();
const skuKey = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9]/g, '').toUpperCase();

function isPeriod(p) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(p || '')); }

function periodLabel(period) {
    const [y, m] = period.split('-').map(Number);
    return `${MONTHS[m - 1]} ${y}`;
}

function lastDayOf(period) {
    const [y, m] = period.split('-').map(Number);
    return `${period}-${pad2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}

/** The Toronto month containing "now". */
function currentPeriod(now = new Date()) { return torontoParts(now).period; }

/** The Toronto month before the one containing "now". */
function previousPeriod(now = new Date()) {
    const t = torontoParts(now);
    return t.m === 1 ? `${t.y - 1}-12` : `${t.y}-${pad2(t.m - 1)}`;
}

/** January of the period's year through the period, oldest first. */
function monthsOfYearThrough(period) {
    const [y, m] = period.split('-').map(Number);
    return Array.from({ length: m }, (_, i) => `${y}-${pad2(i + 1)}`);
}

// ============================================================
// WHICH LINES ARE THE BRAND
// ============================================================

/**
 * Is this order line the brand? The brand frozen on the line when it was
 * ordered wins; an older line without one falls back to the product's current
 * brand, and finally to the part number / name, because 3M parts are filed
 * MMM##### and named "3M ...".
 */
function lineIsBrand(line, brand, info) {
    const target = fold(brand);
    const known = (info && info.get && info.get(line.product_id)) || {};
    const b = fold(line.brand || known.brand);
    if (b) return b === target || b.startsWith(target + ' ');
    if (target === '3m') return /^MMM[-\s]?\d/i.test(String(line.sku || '')) || /^3M\b/i.test(String(line.name || ''));
    return false;
}

const lineQty = l => {
    const q = Number(l.quantity != null ? l.quantity : l.qty);
    return Number.isFinite(q) && q > 0 ? q : 0;
};

/** The price a unit was sold at, or null when it was never priced. */
function linePrice(l) {
    if (l.price_on_request === true) return null;
    const p = l.unit_price != null ? l.unit_price : l.price;
    const n = Number(p);
    return p != null && p !== '' && Number.isFinite(n) && n > 0 ? n : null;
}

// ============================================================
// SHIPMENTS
// ============================================================

/** Which line of the order a backorder entry refers to, the way the console matched it. */
function matchLine(items, raw) {
    return items.findIndex(oi =>
        (raw.product_id && oi.product_id === raw.product_id) ||
        (!raw.product_id && raw.sku && oi.sku === raw.sku) ||
        (!raw.product_id && !raw.sku && raw.name && oi.name === raw.name));
}

/**
 * When, and how much of each line, an order shipped.
 *
 * Walk the status history. Every entry that says Out for Delivery or Closed
 * is a point at which staff recorded where the order stood: "partial" with a
 * backorder list means those quantities are still owed; anything else means
 * nothing is. What shipped at that moment is whatever was still unshipped
 * before it minus whatever is still unshipped after it. That one rule covers a
 * plain shipment, a short shipment, the backorder arriving later, and a
 * "Closed" entry that follows "Out for Delivery" (which ships nothing new).
 *
 * An order with no usable history (older orders) is treated as one shipment of
 * everything, dated by when it closed, last changed or was placed.
 *
 * @returns {Array<{at: string, qty: Map<number, number>}>} qty is line index -> units
 */
function shipmentEvents(order) {
    const items = Array.isArray(order.items) ? order.items : [];
    if (!items.length) return [];
    const history = (Array.isArray(order.status_history) ? order.status_history : [])
        .filter(h => h && SHIPPED_STATUSES.includes(h.status) && torontoParts(h.timestamp))
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // Units not yet shipped, per line. Starts as everything ordered.
    let unshipped = new Map(items.map((l, i) => [i, lineQty(l)]));
    const events = [];

    if (!history.length) {
        const at = order.closed_at || order.updated_at || order.created_at;
        if (!torontoParts(at)) return [];
        return [{ at, qty: new Map(unshipped) }];
    }

    for (const h of history) {
        const stillOwed = new Map(items.map((_, i) => [i, 0]));
        if (h.is_partial_shipment && Array.isArray(h.backorder_items)) {
            for (const raw of h.backorder_items) {
                const i = matchLine(items, raw || {});
                if (i >= 0) stillOwed.set(i, Math.min(lineQty(items[i]), Math.max(0, Number(raw.quantity) || 0)));
            }
        }
        const shipped = new Map();
        for (const [i, before] of unshipped) {
            const after = Math.min(before, stillOwed.get(i) || 0);
            if (before - after > 0) shipped.set(i, before - after);
            stillOwed.set(i, after);
        }
        unshipped = stillOwed;
        if (shipped.size) events.push({ at: h.timestamp, qty: shipped });
    }
    return events;
}

// ============================================================
// ONE MONTH
// ============================================================

/**
 * Add up one brand's shipments within one calendar month.
 *
 *   orders    [{ id, order_number, status, location, items, status_history, created_at, updated_at, closed_at }]
 *   itemInfo  Map(product_id -> { brand, category }) for lines that did not freeze them
 *
 * Cancelled orders are skipped whole, whatever they shipped before.
 */
function buildMonth({ orders, itemInfo, brand, period }) {
    const items = new Map();       // sku key -> row
    const locations = new Map();
    const orderRows = [];
    const orderIds = new Set();
    let qty = 0, amount = 0, unpricedQty = 0;

    for (const o of orders || []) {
        if (!o || !SHIPPED_STATUSES.includes(o.status)) continue;
        const lines = Array.isArray(o.items) ? o.items : [];
        const placedHere = new Map();      // order number -> accumulates across events in this month

        for (const ev of shipmentEvents(o)) {
            const t = torontoParts(ev.at);
            if (!t || t.period !== period) continue;

            for (const [i, units] of ev.qty) {
                const line = lines[i];
                if (!line || !lineIsBrand(line, brand, itemInfo)) continue;
                const known = (itemInfo && itemInfo.get && itemInfo.get(line.product_id)) || {};
                const price = linePrice(line);
                const dollars = price == null ? 0 : units * price;
                const key = skuKey(line.sku) || fold(line.name);

                let row = items.get(key);
                if (!row) {
                    row = { sku: line.sku || '', name: line.name || '', category: line.category || known.category || '',
                            qty: 0, amount: 0, unpriced_qty: 0, orders: 0, _o: new Set() };
                    items.set(key, row);
                }
                row.qty += units; row.amount += dollars;
                if (price == null) row.unpriced_qty += units;
                if (!row._o.has(o.id)) { row._o.add(o.id); row.orders += 1; }

                const locName = (o.location && String(o.location).trim()) || 'Unassigned';
                let loc = locations.get(locName);
                if (!loc) { loc = { location: locName, qty: 0, amount: 0, orders: 0, _o: new Set() }; locations.set(locName, loc); }
                loc.qty += units; loc.amount += dollars;
                if (!loc._o.has(o.id)) { loc._o.add(o.id); loc.orders += 1; }

                const ok = `${o.id}|${t.date}`;
                let orow = placedHere.get(ok);
                if (!orow) {
                    orow = { order_number: o.order_number || '', shipped_on: t.date, location: locName, qty: 0, amount: 0 };
                    placedHere.set(ok, orow);
                    orderRows.push(orow);
                }
                orow.qty += units; orow.amount += dollars;

                qty += units; amount += dollars;
                if (price == null) unpricedQty += units;
                orderIds.add(o.id);
            }
        }
    }

    const itemRows = [...items.values()].map(r => ({
        sku: r.sku, name: r.name, category: r.category, qty: r.qty, amount: cents(r.amount),
        orders: r.orders, unpriced_qty: r.unpriced_qty,
        avg_price: r.qty - r.unpriced_qty > 0 ? cents(r.amount / (r.qty - r.unpriced_qty)) : null
    })).sort((a, b) => b.amount - a.amount || b.qty - a.qty || String(a.sku).localeCompare(String(b.sku)));

    const locRows = [...locations.values()].map(r => ({ location: r.location, orders: r.orders, qty: r.qty, amount: cents(r.amount) }))
        .sort((a, b) => b.amount - a.amount || String(a.location).localeCompare(String(b.location)));

    orderRows.forEach(r => { r.amount = cents(r.amount); });
    orderRows.sort((a, b) => a.shipped_on.localeCompare(b.shipped_on) || String(a.order_number).localeCompare(String(b.order_number)));

    return {
        period, label: periodLabel(period), through: lastDayOf(period), brand,
        totals: { orders: orderIds.size, qty, amount: cents(amount), unpriced_qty: unpricedQty },
        items: itemRows, locations: locRows, orders: orderRows
    };
}

/** Every month of a set of orders in one pass over the data the caller loaded. */
function buildMonths({ orders, itemInfo, brand, periods }) {
    return Object.fromEntries(periods.map(p => [p, buildMonth({ orders, itemInfo, brand, period: p })]));
}

// ============================================================
// YEAR TO DATE
// ============================================================

/**
 * Roll month snapshots (January through the report month) into a year to date.
 * A month with nothing shipped still has a row, so the table has no gaps.
 */
function rollUp(snapshots, { periods, brand }) {
    const items = new Map();
    const locations = new Map();
    const months = [];
    let orders = 0, qty = 0, amount = 0, unpricedQty = 0;

    for (const p of periods) {
        const s = snapshots[p];
        const t = (s && s.totals) || { orders: 0, qty: 0, amount: 0, unpriced_qty: 0 };
        months.push({ period: p, label: periodLabel(p), orders: t.orders, qty: t.qty, amount: cents(t.amount), unpriced_qty: t.unpriced_qty || 0 });
        orders += t.orders; qty += t.qty; amount += t.amount; unpricedQty += t.unpriced_qty || 0;
        for (const r of (s && s.items) || []) {
            const k = skuKey(r.sku) || fold(r.name);
            let row = items.get(k);
            if (!row) { row = { sku: r.sku, name: r.name, category: r.category || '', qty: 0, amount: 0, unpriced_qty: 0, orders: 0 }; items.set(k, row); }
            row.qty += r.qty; row.amount += r.amount; row.unpriced_qty += r.unpriced_qty || 0; row.orders += r.orders;
        }
        for (const r of (s && s.locations) || []) {
            let row = locations.get(r.location);
            if (!row) { row = { location: r.location, orders: 0, qty: 0, amount: 0 }; locations.set(r.location, row); }
            row.orders += r.orders; row.qty += r.qty; row.amount += r.amount;
        }
    }

    const last = periods[periods.length - 1];
    return {
        year: Number(periods[0].slice(0, 4)), through_period: last, through: lastDayOf(last), brand,
        label: `Year to date, ${MONTHS[0]} to ${MONTHS[Number(last.slice(5)) - 1]} ${periods[0].slice(0, 4)}`,
        totals: { orders, qty, amount: cents(amount), unpriced_qty: unpricedQty },
        months,
        items: [...items.values()].map(r => ({
            ...r, amount: cents(r.amount),
            avg_price: r.qty - r.unpriced_qty > 0 ? cents(r.amount / (r.qty - r.unpriced_qty)) : null
        })).sort((a, b) => b.amount - a.amount || b.qty - a.qty || String(a.sku).localeCompare(String(b.sku))),
        locations: [...locations.values()].map(r => ({ ...r, amount: cents(r.amount) })).sort((a, b) => b.amount - a.amount)
    };
}

// ============================================================
// FILES
// ============================================================

const money = n => '$' + Number(n || 0).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const intf = n => Number(n || 0).toLocaleString('en-CA', { maximumFractionDigits: 2 });

/** The one file name both formats share. */
function fileBase({ company, brand, period }) {
    const slug = String(company || 'customer').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'customer';
    return `${slug}-${String(brand || 'brand').toLowerCase().replace(/[^a-z0-9]+/g, '')}-sales-${period}`;
}

/**
 * The workbook: Summary, Items, By location, Orders, Year to date.
 * report = { company, brand, month (a buildMonth result), ytd (a rollUp result),
 *            generated_at, partial }
 */
function renderXlsx(report) {
    const { company, brand, month, ytd } = report;
    const wb = XLSX.utils.book_new();
    const col = (ws, widths) => { ws['!cols'] = widths.map(wch => ({ wch })); };
    const fmt = (ws, colLetters, z, fromRow, toRow) => {
        for (const c of colLetters) for (let r = fromRow; r <= toRow; r++) { const cell = ws[`${c}${r}`]; if (cell && cell.t === 'n') cell.z = z; }
    };
    const MONEY = '"$"#,##0.00';

    const mUnpriced = month.totals.unpriced_qty;
    const sum = [
        [`${company} - ${brand} sales`],
        [month.label + (report.partial ? ` (month to date, through ${report.as_of})` : '')],
        [],
        ['', 'Orders', 'Units', 'Dollars'],
        [month.label, month.totals.orders, month.totals.qty, month.totals.amount],
        [ytd.label, ytd.totals.orders, ytd.totals.qty, ytd.totals.amount],
        [],
        ...(mUnpriced || ytd.totals.unpriced_qty ? [[`Units not yet priced: ${intf(mUnpriced)} this month, ${intf(ytd.totals.unpriced_qty)} year to date. Their dollars are not in the totals above.`], []] : []),
        ['How this is counted'],
        [BASIS_TEXT],
        [],
        [report.generated_at ? `Generated ${String(report.generated_at).slice(0, 10)}` : '']
    ];
    const wsS = XLSX.utils.aoa_to_sheet(sum); col(wsS, [38, 10, 10, 16]); fmt(wsS, ['D'], MONEY, 5, 6);
    XLSX.utils.book_append_sheet(wb, wsS, 'Summary');

    const itemHead = ['Item #', 'Description', 'Category', 'Units', 'Dollars', 'Avg price', 'Orders', 'Units not priced'];
    const itemRows = (list) => list.map(r => [r.sku, r.name, r.category, r.qty, r.amount, r.avg_price == null ? '' : r.avg_price, r.orders, r.unpriced_qty || 0]);
    const totalRow = (t) => ['', 'Total', '', t.qty, t.amount, '', '', t.unpriced_qty || 0];
    const wsI = XLSX.utils.aoa_to_sheet([itemHead, ...itemRows(month.items), totalRow(month.totals)]);
    col(wsI, [14, 56, 20, 9, 14, 12, 8, 16]); fmt(wsI, ['E', 'F'], MONEY, 2, month.items.length + 2);
    XLSX.utils.book_append_sheet(wb, wsI, 'Items');

    const wsL = XLSX.utils.aoa_to_sheet([['Location', 'Orders', 'Units', 'Dollars'],
        ...month.locations.map(r => [r.location, r.orders, r.qty, r.amount]),
        ['Total', month.totals.orders, month.totals.qty, month.totals.amount]]);
    col(wsL, [34, 9, 9, 14]); fmt(wsL, ['D'], MONEY, 2, month.locations.length + 2);
    XLSX.utils.book_append_sheet(wb, wsL, 'By location');

    const wsO = XLSX.utils.aoa_to_sheet([['Order #', 'Shipped', 'Location', 'Units', 'Dollars'],
        ...month.orders.map(r => [r.order_number, r.shipped_on, r.location, r.qty, r.amount])]);
    col(wsO, [16, 12, 30, 9, 14]); fmt(wsO, ['E'], MONEY, 2, month.orders.length + 1);
    XLSX.utils.book_append_sheet(wb, wsO, 'Orders');

    const ytdRows = [
        [ytd.label], [],
        ['Month', 'Orders', 'Units', 'Dollars'],
        ...ytd.months.map(r => [r.label, r.orders, r.qty, r.amount]),
        ['Year to date', ytd.totals.orders, ytd.totals.qty, ytd.totals.amount],
        [], ['Item breakdown, year to date'],
        itemHead, ...itemRows(ytd.items), totalRow(ytd.totals)
    ];
    const wsY = XLSX.utils.aoa_to_sheet(ytdRows); col(wsY, [30, 56, 20, 9, 14, 12, 8, 16]);
    const monthsEnd = 3 + ytd.months.length + 1;
    fmt(wsY, ['D'], MONEY, 4, monthsEnd);
    fmt(wsY, ['E', 'F'], MONEY, monthsEnd + 4, monthsEnd + 4 + ytd.items.length + 1);
    XLSX.utils.book_append_sheet(wb, wsY, 'Year to date');

    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** The PDF: one summary page, the item breakdown, the year to date. Resolves to a Buffer. */
function renderPdf(report) {
    const { company, brand, month, ytd } = report;
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'LETTER', margin: 48, info: { Title: `${company} ${brand} sales ${month.label}` } });
        const chunks = [];
        doc.on('data', c => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const INK = '#1f2937', MUTED = '#6b7280', RULE = '#d1d5db', ACCENT = '#1d4ed8';
        const left = doc.page.margins.left;
        const width = doc.page.width - left - doc.page.margins.right;

        const bottom = () => doc.page.height - doc.page.margins.bottom;
        const ensure = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

        // columns: [{label, w, align, get}]
        function table(cols, rows, totals) {
            const draw = (cells, opts = {}) => {
                ensure(18);
                const y = doc.y;
                let x = left;
                doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(opts.color || INK);
                cols.forEach((c, i) => {
                    doc.text(String(cells[i] == null ? '' : cells[i]), x + 2, y, { width: c.w - 4, align: c.align || 'left', lineBreak: false, ellipsis: true });
                    x += c.w;
                });
                doc.y = y + 15;
                if (opts.rule) doc.moveTo(left, doc.y - 3).lineTo(left + width, doc.y - 3).strokeColor(RULE).lineWidth(0.5).stroke();
            };
            draw(cols.map(c => c.label), { bold: true, color: MUTED, rule: true });
            rows.forEach(r => { if (doc.y + 18 > bottom()) { doc.addPage(); draw(cols.map(c => c.label), { bold: true, color: MUTED, rule: true }); } draw(cols.map(c => c.get(r))); });
            if (totals) { doc.moveTo(left, doc.y - 2).lineTo(left + width, doc.y - 2).strokeColor(INK).lineWidth(0.8).stroke(); draw(cols.map(c => c.get(totals)), { bold: true }); }
            doc.moveDown(0.6);
        }

        const heading = (text) => { ensure(40); doc.moveDown(0.4).font('Helvetica-Bold').fontSize(11).fillColor(INK).text(text, left, doc.y); doc.moveDown(0.3); };

        // Header
        doc.font('Helvetica-Bold').fontSize(18).fillColor(INK).text(`${company}`, left, 48);
        doc.font('Helvetica').fontSize(12).fillColor(ACCENT).text(`${brand} sales report - ${month.label}${report.partial ? ' (month to date)' : ''}`);
        doc.fontSize(8.5).fillColor(MUTED).text(report.generated_at ? `Generated ${String(report.generated_at).slice(0, 10)}` : '');
        doc.moveDown(0.8);

        // Summary tiles
        const y0 = doc.y; const colW = width / 3;
        [['Dollars', money(month.totals.amount), `Year to date: ${money(ytd.totals.amount)}`],
         ['Units', intf(month.totals.qty), `Year to date: ${intf(ytd.totals.qty)}`],
         ['Orders', intf(month.totals.orders), `Year to date: ${intf(ytd.totals.orders)}`]].forEach((t, i) => {
            const x = left + i * colW;
            doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(t[0].toUpperCase(), x, y0, { width: colW - 8 });
            doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(t[1], x, y0 + 12, { width: colW - 8 });
            doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(t[2], x, y0 + 38, { width: colW - 8 });
        });
        doc.y = y0 + 58;
        if (month.totals.unpriced_qty || ytd.totals.unpriced_qty) {
            doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#b45309')
                .text(`${intf(month.totals.unpriced_qty)} units this month (${intf(ytd.totals.unpriced_qty)} year to date) have no price yet; their dollars are not included.`, left, doc.y, { width });
            doc.moveDown(0.5);
        }

        const itemCols = [
            { label: 'Item #', w: 70, get: r => r.sku },
            { label: 'Description', w: 232, get: r => r.name },
            { label: 'Units', w: 48, align: 'right', get: r => intf(r.qty) },
            { label: 'Orders', w: 44, align: 'right', get: r => r.orders === '' ? '' : intf(r.orders) },
            { label: 'Avg price', w: 56, align: 'right', get: r => r.avg_price == null ? '' : money(r.avg_price) },
            { label: 'Dollars', w: 62, align: 'right', get: r => (r.qty > 0 && r.unpriced_qty === r.qty) ? 'Needs pricing' : money(r.amount) }
        ];
        heading(`Item breakdown - ${month.label}`);
        if (month.items.length) table(itemCols, month.items, { sku: '', name: 'Total', qty: month.totals.qty, orders: '', avg_price: null, amount: month.totals.amount });
        else doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`No ${brand} items shipped in ${month.label}.`, left, doc.y);

        if (month.locations.length) {
            heading('By location');
            table([
                { label: 'Location', w: 262, get: r => r.location },
                { label: 'Orders', w: 60, align: 'right', get: r => intf(r.orders) },
                { label: 'Units', w: 60, align: 'right', get: r => intf(r.qty) },
                { label: 'Dollars', w: 90, align: 'right', get: r => money(r.amount) }
            ], month.locations);
        }

        // Year to date
        doc.addPage();
        doc.font('Helvetica-Bold').fontSize(14).fillColor(INK).text(ytd.label, left, 48);
        doc.moveDown(0.5);
        table([
            { label: 'Month', w: 202, get: r => r.label },
            { label: 'Orders', w: 70, align: 'right', get: r => intf(r.orders) },
            { label: 'Units', w: 70, align: 'right', get: r => intf(r.qty) },
            { label: 'Dollars', w: 100, align: 'right', get: r => money(r.amount) }
        ], ytd.months, { label: 'Year to date', orders: ytd.totals.orders, qty: ytd.totals.qty, amount: ytd.totals.amount });
        heading('Item breakdown, year to date');
        if (ytd.items.length) table(itemCols, ytd.items, { sku: '', name: 'Total', qty: ytd.totals.qty, orders: '', avg_price: null, amount: ytd.totals.amount });

        ensure(60);
        doc.moveDown(0.5).font('Helvetica-Bold').fontSize(8.5).fillColor(MUTED).text('How this is counted', left, doc.y);
        doc.font('Helvetica').fontSize(8.5).text(BASIS_TEXT, left, doc.y, { width });
        doc.end();
    });
}

module.exports = {
    TZ, SHIPPED_STATUSES, BASIS_TEXT,
    torontoParts, isPeriod, periodLabel, lastDayOf, currentPeriod, previousPeriod, monthsOfYearThrough,
    lineIsBrand, linePrice, shipmentEvents, buildMonth, buildMonths, rollUp,
    fileBase, renderXlsx, renderPdf, skuKey
};
