/**
 * public/purchase-report.js -- the Purchase report PDF.
 *
 * One report for both consoles (shop Reports screen and CHC Reports), built
 * from the orders the screen already loaded with its filters:
 *
 *   1. Summary        orders, units, item dollars before tax, order totals
 *   2. By location    one row per shop
 *   3. By order       every order: date, number, shop, PO, ordered by, status
 *   4. By item        every item bought, with average price
 *   5. Items by location   each shop's own item list
 *
 * Cancelled orders are left out (and counted, so the reader knows). A company
 * that hides pricing gets units only. The CSV downloads are unchanged.
 *
 * buildPurchaseReport() is pure (tested in tests/purchase-report.test.js);
 * downloadPurchasePdf() draws it with jsPDF + autoTable, already on both pages.
 */
(function (root) {
    'use strict';

    const STATUS = { pending: 'Pending', processing: 'Processing', confirmed: 'Confirmed', out_on_delivery: 'Out for delivery',
        delivered: 'Delivered', closed: 'Closed', cancelled: 'Cancelled', canceled: 'Cancelled' };
    const cents = n => Math.round((Number(n) || 0) * 100) / 100;
    const qtyOf = l => { const q = Number(l && (l.quantity != null ? l.quantity : l.qty)); return Number.isFinite(q) && q > 0 ? q : 0; };
    const lineDollars = l => {
        if (!l || l.price_on_request === true) return null;
        if (l.subtotal != null && l.subtotal !== '' && Number.isFinite(Number(l.subtotal))) return Number(l.subtotal);
        const p = Number(l.unit_price != null ? l.unit_price : l.price);
        return Number.isFinite(p) && p > 0 ? p * qtyOf(l) : null;
    };
    const statusText = o => o.status_label || STATUS[o.status] || String(o.status || '').replace(/_/g, ' ');
    const byText = (a, b) => String(a).localeCompare(String(b), 'en', { sensitivity: 'base' });

    /**
     * orders  [{ id, order_number, created_at, status, status_label?, location, location_id, company_name?,
     *            po_number, contact_name, subtotal, tax, total, pricing_hidden?, items: [line] }]
     * opts    { itemTerm }  narrow item sections to lines whose name or SKU contains it (same as the screen)
     */
    function buildPurchaseReport(orders, opts) {
        const term = String((opts && opts.itemTerm) || '').trim().toLowerCase();
        const match = l => !term || String(l.name || '').toLowerCase().includes(term) || String(l.sku || '').toLowerCase().includes(term);
        const list = (orders || []).filter(Boolean);
        const multiCompany = new Set(list.map(o => o.company_name || '')).size > 1;
        const shopName = o => {
            const s = (o.location && String(o.location).trim()) || 'Unassigned';
            return multiCompany && o.company_name ? `${o.company_name} - ${s}` : s;
        };
        const hidePricing = list.some(o => o.pricing_hidden === true);

        let cancelled = 0;
        const locs = new Map(), items = new Map(), itemsByLoc = new Map(), orderRows = [];
        const sum = { orders: 0, units: 0, item_dollars: 0, tax: 0, total: 0, unpriced_units: 0 };

        for (const o of list) {
            const st = String(o.status || '').toLowerCase();
            if (st === 'cancelled' || st === 'canceled') { cancelled += 1; continue; }
            const lines = (Array.isArray(o.items) ? o.items : []).filter(match);
            if (term && !lines.length) continue;

            let units = 0, dollars = 0, unpriced = 0;
            const shop = shopName(o);
            for (const l of lines) {
                const q = qtyOf(l); if (!q) continue;
                const d = lineDollars(l);
                units += q;
                if (d == null) unpriced += q; else dollars += d;

                const key = String(l.sku || l.name || '').trim().toUpperCase();
                let it = items.get(key);
                if (!it) { it = { sku: l.sku || '', name: l.name || '', units: 0, dollars: 0, priced_units: 0, unpriced_units: 0, _o: new Set(), _s: new Set() }; items.set(key, it); }
                it.units += q; it._o.add(o.id); it._s.add(shop);
                if (d == null) it.unpriced_units += q; else { it.dollars += d; it.priced_units += q; }

                if (!itemsByLoc.has(shop)) itemsByLoc.set(shop, new Map());
                const m = itemsByLoc.get(shop);
                let li = m.get(key);
                if (!li) { li = { sku: l.sku || '', name: l.name || '', units: 0, dollars: 0, _o: new Set() }; m.set(key, li); }
                li.units += q; li._o.add(o.id); if (d != null) li.dollars += d;
            }

            const tax = Number(o.tax) || 0;
            const total = Number(o.total) || 0;
            sum.orders += 1; sum.units += units; sum.item_dollars += dollars; sum.unpriced_units += unpriced;
            if (!term) { sum.tax += tax; sum.total += total; }

            let loc = locs.get(shop);
            if (!loc) { loc = { location: shop, orders: 0, units: 0, item_dollars: 0, total: 0, last: null }; locs.set(shop, loc); }
            loc.orders += 1; loc.units += units; loc.item_dollars += dollars; if (!term) loc.total += total;
            if (!loc.last || String(o.created_at) > loc.last) loc.last = String(o.created_at);

            orderRows.push({ date: o.created_at, order_number: o.order_number || '', location: shop, po: o.po_number || '',
                ordered_by: o.contact_name || '', status: statusText(o), lines: lines.length, units,
                item_dollars: cents(dollars), total: term ? null : cents(total) });
        }

        const itemRows = [...items.values()].map(i => ({
            sku: i.sku, name: i.name, units: i.units, orders: i._o.size, shops: i._s.size, dollars: cents(i.dollars),
            unpriced_units: i.unpriced_units, avg_price: i.priced_units ? cents(i.dollars / i.priced_units) : null
        })).sort((a, b) => b.dollars - a.dollars || b.units - a.units || byText(a.sku, b.sku));

        return {
            hide_pricing: hidePricing,
            item_filter: term || null,
            multi_company: multiCompany,
            cancelled_excluded: cancelled,
            summary: {
                orders: sum.orders, units: sum.units, unique_items: itemRows.length, shops: locs.size,
                item_dollars: cents(sum.item_dollars), tax: term ? null : cents(sum.tax), total: term ? null : cents(sum.total),
                unpriced_units: sum.unpriced_units
            },
            locations: [...locs.values()].map(l => ({ ...l, item_dollars: cents(l.item_dollars), total: term ? null : cents(l.total) }))
                .sort((a, b) => b.item_dollars - a.item_dollars || b.units - a.units || byText(a.location, b.location)),
            orders: orderRows.sort((a, b) => String(a.date).localeCompare(String(b.date)) || byText(a.order_number, b.order_number)),
            items: itemRows,
            items_by_location: [...itemsByLoc.entries()].sort((a, b) => byText(a[0], b[0])).map(([location, m]) => ({
                location,
                items: [...m.values()].map(i => ({ sku: i.sku, name: i.name, units: i.units, orders: i._o.size, dollars: cents(i.dollars) }))
                    .sort((a, b) => b.dollars - a.dollars || b.units - a.units || byText(a.sku, b.sku))
            }))
        };
    }

    // ------------------------------------------------------------------
    // Drawing
    // ------------------------------------------------------------------
    const money = n => n == null ? '' : '$' + Number(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const day = ts => { const d = new Date(ts); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-CA'); };

    /**
     * meta { title, company, shop, period, fileBase }
     * mode 'save' downloads the file; 'print' opens it in a new tab.
     */
    function downloadPurchasePdf(report, meta, mode) {
        const J = root.jspdf;
        if (!J || !J.jsPDF) { alert('The PDF maker is still loading. Try again in a moment.'); return null; }
        const doc = new J.jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
        if (typeof doc.autoTable !== 'function') { alert('The PDF maker is still loading. Try again in a moment.'); return null; }
        const r = report, hide = r.hide_pricing;
        const W = doc.internal.pageSize.getWidth(), M = 36;
        const NAVY = [14, 26, 43], BLUE = [23, 71, 214], MUTED = [90, 100, 115];
        const head = { fillColor: NAVY, textColor: 255, fontStyle: 'bold', fontSize: 8 };
        const base = { fontSize: 8, cellPadding: 3, overflow: 'linebreak' };
        let y = M;

        // Header
        doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.setTextColor(...NAVY);
        doc.text(meta.title || 'Purchase report', M, y + 8);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTED);
        doc.text('CHC Paint & Auto Body Supplies | refinishAI', W - M, y + 2, { align: 'right' });
        doc.text('Generated ' + new Date().toLocaleString('en-CA'), W - M, y + 14, { align: 'right' });
        y += 26;
        doc.setFontSize(10); doc.setTextColor(30, 30, 30);
        const line2 = [meta.company && ('Company: ' + meta.company), 'Shop: ' + (meta.shop || 'All shops'), 'Period: ' + (meta.period || 'All time')].filter(Boolean).join('     ');
        doc.text(line2, M, y);
        y += 14;
        if (r.item_filter) { doc.setTextColor(...MUTED); doc.text(`Items matching "${r.item_filter}" only.`, M, y); y += 14; }

        // 1. Summary
        const s = r.summary;
        const cards = hide
            ? [['Orders', String(s.orders)], ['Units', s.units.toLocaleString()], ['Unique items', String(s.unique_items)], ['Shops', String(s.shops)]]
            : [['Orders', String(s.orders)], ['Item dollars', money(s.item_dollars)], ...(s.total != null ? [['Order totals', money(s.total)]] : []),
               ['Units', s.units.toLocaleString()], ['Unique items', String(s.unique_items)], ['Shops', String(s.shops)]];
        const cw = (W - 2 * M - (cards.length - 1) * 8) / cards.length;
        cards.forEach(([k, v], i) => {
            const x = M + i * (cw + 8);
            doc.setDrawColor(223, 228, 236); doc.roundedRect(x, y, cw, 44, 4, 4, 'S');
            doc.setFontSize(7.5); doc.setTextColor(...MUTED); doc.text(k.toUpperCase(), x + 8, y + 14, { maxWidth: cw - 16 });
            doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(...NAVY); doc.text(v, x + 8, y + 34);
            doc.setFont('helvetica', 'normal');
        });
        y += 58;

        const section = (title, note) => {
            if (y > doc.internal.pageSize.getHeight() - 120) { doc.addPage(); y = M; }
            doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...BLUE); doc.text(title, M, y);
            doc.setFont('helvetica', 'normal');
            y += 6;
            if (note) { doc.setFontSize(8); doc.setTextColor(...MUTED); doc.text(note, M, y + 8); y += 12; }
        };
        const table = (columns, body, extra) => {
            doc.autoTable({
                startY: y + 4, margin: { left: M, right: M, bottom: 40 }, head: [columns.map(c => c[0])], body,
                styles: base, headStyles: head, alternateRowStyles: { fillColor: [246, 248, 251] },
                columnStyles: Object.fromEntries(columns.map((c, i) => [i, { halign: c[1] || 'left', ...(c[2] ? { cellWidth: c[2] } : {}) }])),
                ...(extra || {})
            });
            y = doc.lastAutoTable.finalY + 22;
        };
        const empty = [['Nothing purchased in this range.']];

        // 2. By location
        section('By location');
        const locCols = [['Shop'], ['Orders', 'right'], ['Units', 'right'], ...(hide ? [] : [['Item dollars', 'right'], ...(s.total != null ? [['Order totals', 'right']] : [])]), ['Last order', 'right']];
        const locBody = r.locations.map(l => [l.location, l.orders, l.units, ...(hide ? [] : [money(l.item_dollars), ...(s.total != null ? [money(l.total)] : [])]), day(l.last)]);
        if (r.locations.length > 1) locBody.push([{ content: 'All shops', styles: { fontStyle: 'bold' } }, s.orders, s.units,
            ...(hide ? [] : [money(s.item_dollars), ...(s.total != null ? [money(s.total)] : [])]), '']);
        table(locCols, locBody.length ? locBody : empty);

        // 3. By order
        section('By order');
        const ordCols = [['Date', 'left', 62], ['Order #', 'left', 104], ['Shop'], ['PO'], ['Ordered by'], ['Status'], ['Units', 'right', 44],
            ...(hide ? [] : [['Item dollars', 'right', 70], ...(s.total != null ? [['Order total', 'right', 70]] : [])])];
        table(ordCols, r.orders.length ? r.orders.map(o => [day(o.date), o.order_number, o.location, o.po, o.ordered_by, o.status, o.units,
            ...(hide ? [] : [money(o.item_dollars), ...(s.total != null ? [money(o.total)] : [])])]) : empty);

        // 4. By item
        section('By item', hide ? '' : 'Average price is item dollars divided by priced units.');
        const itemCols = [['Part #', 'left', 90], ['Item'], ['Units', 'right', 50], ['Orders', 'right', 50], ['Shops', 'right', 44],
            ...(hide ? [] : [['Item dollars', 'right', 76], ['Avg price', 'right', 66]])];
        table(itemCols, r.items.length ? r.items.map(i => [i.sku, i.name, i.units, i.orders, i.shops,
            ...(hide ? [] : [money(i.dollars), i.avg_price == null ? 'To be priced' : money(i.avg_price)])]) : empty);

        // 5. Items by location
        if (r.items_by_location.length > 1) {
            section('Items by location');
            for (const g of r.items_by_location) {
                if (y > doc.internal.pageSize.getHeight() - 100) { doc.addPage(); y = M; }
                doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...NAVY); doc.text(g.location, M, y + 12);
                doc.setFont('helvetica', 'normal');
                y += 14;
                table([['Part #', 'left', 90], ['Item'], ['Units', 'right', 50], ['Orders', 'right', 50], ...(hide ? [] : [['Item dollars', 'right', 76]])],
                    g.items.map(i => [i.sku, i.name, i.units, i.orders, ...(hide ? [] : [money(i.dollars)])]));
            }
        }

        // Basis and page numbers on every page
        const basis = [
            'Item dollars are before tax, delivery fee and fuel surcharge; order totals include them. Dated by order date.',
            r.cancelled_excluded ? `Cancelled orders are not included (${r.cancelled_excluded} left out).` : 'Cancelled orders are not included.',
            s.unpriced_units ? `${s.unpriced_units} unit(s) still to be priced count as units, not dollars.` : ''
        ].filter(Boolean).join(' ');
        const pages = doc.internal.getNumberOfPages();
        for (let p = 1; p <= pages; p++) {
            doc.setPage(p);
            const h = doc.internal.pageSize.getHeight();
            doc.setFontSize(7); doc.setTextColor(...MUTED);
            doc.text(basis, M, h - 22, { maxWidth: W - 2 * M - 70 });
            doc.text(`Page ${p} of ${pages}`, W - M, h - 22, { align: 'right' });
        }

        const file = `${meta.fileBase || 'purchase-report'}.pdf`;
        if (mode === 'print') doc.output('dataurlnewwindow'); else doc.save(file);
        return doc;
    }

    const api = { buildPurchaseReport, downloadPurchasePdf };
    root.PurchaseReport = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
