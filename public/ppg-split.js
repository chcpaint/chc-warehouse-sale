/**
 * public/ppg-split.js -- the "PPG paint lines vs sundries" card.
 *
 * One renderer for both consoles:
 *   shop Reports screen   PPGS.loadStore(params, periodLabel)  -> /api/store/:slug/reports/ppg-split
 *   CHC admin Reports     PPGS.render(el, data, opts)          (admin fetches with its own token)
 *
 * Views: by shop, by month, by item, PPG by line. Each downloads as CSV.
 * Read-only, apart from the admin's "move to" correction button, which only
 * appears when opts.onCorrect is given (super admins).
 */
(function () {
    'use strict';
    const esc = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const money = n => '$' + (Number(n) || 0).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthLabel = p => { const [y, m] = String(p).split('-'); return `${MONTHS[Number(m) - 1] || m} ${y}`; };
    const VIEWS = [['shops', 'By shop'], ['months', 'By month'], ['items', 'By item'], ['lines', 'PPG by line']];

    const state = new WeakMap();   // container -> { data, opts, view, group }

    function css() {
        if (document.getElementById('ppgs-css')) return;
        const s = document.createElement('style');
        s.id = 'ppgs-css';
        s.textContent = `
        .ppgs{background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden}
        .ppgs-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #e5e7eb;background:#f9fafb}
        .ppgs-head h3{margin:0;font-size:15px;font-weight:700;color:#1f2937}
        .ppgs-head small{color:#6b7280;font-size:12px}
        .ppgs-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;padding:14px 16px 4px}
        .ppgs-tile{border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px}
        .ppgs-tile p{margin:0}.ppgs-tile .k{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;font-weight:600}
        .ppgs-tile .v{font-size:22px;font-weight:800;color:#111827;margin-top:2px;font-variant-numeric:tabular-nums}
        .ppgs-tile .s{font-size:12.5px;color:#4b5563;margin-top:2px}
        .ppgs-tile.ppg{border-left:4px solid #1747D6}.ppgs-tile.sun{border-left:4px solid #C2410C}
        .ppgs-bar{display:flex;height:10px;border-radius:999px;overflow:hidden;background:#f3f4f6;margin:10px 16px 2px}
        .ppgs-bar span{display:block;height:100%}.ppgs-bar .b-ppg{background:#1747D6}.ppgs-bar .b-sun{background:#C2410C}
        .ppgs-tabs{display:flex;flex-wrap:wrap;gap:6px;padding:12px 16px}
        .ppgs-tabs button{border:1px solid #d1d5db;background:#fff;border-radius:999px;padding:5px 12px;font-size:13px;cursor:pointer;color:#374151}
        .ppgs-tabs button[aria-pressed="true"]{background:#1747D6;border-color:#1747D6;color:#fff}
        .ppgs-tabs .sp{flex:1}
        .ppgs-table{overflow-x:auto}
        .ppgs-table table{width:100%;border-collapse:collapse;font-size:13.5px;min-width:560px}
        .ppgs-table th{font-size:11px;text-transform:uppercase;color:#6b7280;text-align:left;padding:8px 16px;background:#f9fafb;white-space:nowrap}
        .ppgs-table td{padding:8px 16px;border-top:1px solid #f1f5f9;font-variant-numeric:tabular-nums}
        .ppgs-table .r{text-align:right}.ppgs-table tr.tot td{font-weight:700;background:#f9fafb}
        .ppgs-pill{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11.5px;font-weight:600;white-space:nowrap}
        .ppgs-pill.ppg{background:#E8EEFD;color:#0F35A8}.ppgs-pill.sun{background:#FDEEE6;color:#9A3412}
        .ppgs-note{font-size:12px;color:#6b7280;padding:8px 16px 14px;margin:0}
        .ppgs-fix{border:1px solid #d1d5db;background:#fff;border-radius:8px;padding:2px 8px;font-size:12px;cursor:pointer;white-space:nowrap}
        .ppgs-fix:hover{border-color:#1747D6;color:#1747D6}
        .ppgs-empty{padding:18px 16px;color:#9ca3af;text-align:center}`;
        document.head.appendChild(s);
    }

    function pill(group) {
        return group === 'ppg' ? '<span class="ppgs-pill ppg">PPG paint</span>' : '<span class="ppgs-pill sun">Sundries</span>';
    }

    function tiles(d, hide) {
        const t = d.totals || {};
        const p = t.ppg || {}, s = t.sundries || {};
        const val = b => hide ? `${(b.qty || 0).toLocaleString()} units` : money(b.amount);
        const sub = b => hide ? `${b.orders || 0} orders` : `${b.share || 0}% of item dollars · ${(b.qty || 0).toLocaleString()} units`;
        const bar = hide ? '' : `<div class="ppgs-bar" role="img" aria-label="PPG ${p.share || 0}%, sundries ${s.share || 0}%">
            <span class="b-ppg" style="width:${p.share || 0}%"></span><span class="b-sun" style="width:${s.share || 0}%"></span></div>`;
        return `<div class="ppgs-tiles">
            <div class="ppgs-tile ppg"><p class="k">PPG paint lines</p><p class="v">${val(p)}</p><p class="s">${sub(p)}</p></div>
            <div class="ppgs-tile sun"><p class="k">Sundries</p><p class="v">${val(s)}</p><p class="s">${sub(s)}</p></div>
            ${hide ? '' : `<div class="ppgs-tile"><p class="k">Item dollars</p><p class="v">${money(t.total && t.total.amount)}</p><p class="s">${d.orders || 0} orders · before tax and fees</p></div>`}
        </div>${bar}`;
    }

    function table(head, rows, total) {
        if (!rows.length) return '<p class="ppgs-empty">Nothing purchased in this range.</p>';
        return `<div class="ppgs-table"><table><thead><tr>${head.map(h => `<th class="${h[1] || ''}">${h[0]}</th>`).join('')}</tr></thead>
            <tbody>${rows.join('')}${total || ''}</tbody></table></div>`;
    }

    function pairCells(r, hide) {
        if (hide) return `<td class="r">${r.ppg.qty}</td><td class="r">${r.sundries.qty}</td>`;
        return `<td class="r">${money(r.ppg.amount)}</td><td class="r">${r.ppg.share}%</td><td class="r">${money(r.sundries.amount)}</td><td class="r">${r.sundries.share}%</td><td class="r">${money(r.total.amount)}</td>`;
    }
    const pairHead = hide => hide
        ? [['PPG units', 'r'], ['Sundries units', 'r']]
        : [['PPG paint', 'r'], ['PPG %', 'r'], ['Sundries', 'r'], ['Sundries %', 'r'], ['Total', 'r']];

    function view(d, st) {
        const hide = !!d.pricing_hidden;
        if (st.view === 'shops') {
            const rows = (d.shops || []).map(r => `<tr><td>${esc(r.location)}</td>${pairCells(r, hide)}</tr>`);
            const tot = (d.shops || []).length > 1 ? `<tr class="tot"><td>All shops</td>${pairCells({ ...d.totals }, hide)}</tr>` : '';
            return table([['Shop'], ...pairHead(hide)], rows, tot);
        }
        if (st.view === 'months') {
            const multi = (d.shops || []).length > 1;
            const src = multi ? (d.shop_months || []) : (d.months || []);
            const rows = src.map(r => `<tr><td>${esc(monthLabel(r.period))}</td>${multi ? `<td>${esc(r.location)}</td>` : ''}${pairCells(r, hide)}</tr>`);
            return table([['Month'], ...(multi ? [['Shop']] : []), ...pairHead(hide)], rows);
        }
        if (st.view === 'lines') {
            const rows = (d.ppg_lines || []).map(l => `<tr><td>${esc(l.line)}</td><td class="r">${l.qty}</td>${hide ? '' : `<td class="r">${money(l.amount)}</td>`}</tr>`);
            return table([['PPG line'], ['Units', 'r'], ...(hide ? [] : [['Dollars', 'r']])], rows);
        }
        // items
        const items = (d.items || []).filter(i => st.group === 'all' || i.group === st.group);
        const canFix = typeof st.opts.onCorrect === 'function';
        const rows = items.slice(0, 500).map(i => `<tr>
            <td>${pill(i.group)}</td><td>${esc(i.sku || '-')}</td><td>${esc(i.name)}</td><td>${esc(i.line || '')}</td>
            <td class="r">${i.qty}</td>${hide ? '' : `<td class="r">${money(i.amount)}</td>`}<td class="r">${i.orders}</td>
            ${canFix ? `<td><button type="button" class="ppgs-fix" data-sku="${esc(i.sku)}" data-to="${i.group === 'ppg' ? 'sundries' : 'ppg'}" ${i.sku ? '' : 'disabled'}
                title="${esc(i.reason || '')}">Move to ${i.group === 'ppg' ? 'sundries' : 'PPG'}</button></td>` : ''}
        </tr>`);
        const more = items.length > 500 ? `<p class="ppgs-note">Showing the first 500 of ${items.length} items. Download the CSV for all of them.</p>` : '';
        return `<div class="ppgs-tabs" style="padding-top:0">
                ${[['all', 'All items'], ['ppg', 'PPG paint'], ['sundries', 'Sundries']].map(([k, l]) =>
                    `<button type="button" data-group="${k}" aria-pressed="${st.group === k}">${l}</button>`).join('')}
            </div>` + table([['Group'], ['Part #'], ['Item'], ['PPG line'], ['Units', 'r'], ...(hide ? [] : [['Dollars', 'r']]), ['Orders', 'r'], ...(canFix ? [['']] : [])], rows) + more;
    }

    function draw(el) {
        const st = state.get(el);
        const d = st.data;
        const hide = !!d.pricing_hidden;
        el.innerHTML = `<section class="ppgs" aria-label="PPG paint lines and sundries">
            <div class="ppgs-head"><div><h3>PPG paint lines vs sundries</h3><small>${esc(st.opts.periodLabel || '')}${st.opts.shopLabel ? ' · ' + esc(st.opts.shopLabel) : ''}</small></div>
                <button type="button" class="ppgs-fix" data-csv="1"><i class="fas fa-file-csv" aria-hidden="true"></i> CSV</button></div>
            ${tiles(d, hide)}
            <div class="ppgs-tabs" role="group" aria-label="View">
                ${VIEWS.map(([k, l]) => `<button type="button" data-view="${k}" aria-pressed="${st.view === k}">${l}</button>`).join('')}
            </div>
            <div class="ppgs-body">${view(d, st)}</div>
            <p class="ppgs-note">${esc(d.basis || '')}</p>
        </section>`;
    }

    function csv(el) {
        const st = state.get(el); const d = st.data; const hide = !!d.pricing_hidden;
        const cell = v => { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
        const pair = r => hide ? [r.ppg.qty, r.sundries.qty] : [r.ppg.amount, r.ppg.share, r.sundries.amount, r.sundries.share, r.total.amount];
        const pairH = hide ? ['PPG units', 'Sundries units'] : ['PPG paint $', 'PPG %', 'Sundries $', 'Sundries %', 'Total $'];
        let rows;
        if (st.view === 'shops') rows = [['Shop', ...pairH], ...(d.shops || []).map(r => [r.location, ...pair(r)])];
        else if (st.view === 'months') rows = [['Month', 'Shop', ...pairH], ...(d.shop_months || []).map(r => [r.period, r.location, ...pair(r)])];
        else if (st.view === 'lines') rows = [['PPG line', 'Units', ...(hide ? [] : ['Dollars'])], ...(d.ppg_lines || []).map(l => [l.line, l.qty, ...(hide ? [] : [l.amount])])];
        else rows = [['Group', 'Part #', 'Item', 'PPG line', 'Units', ...(hide ? [] : ['Dollars']), 'Orders', 'Shops', 'Why'],
            ...(d.items || []).map(i => [i.group === 'ppg' ? 'PPG paint' : 'Sundries', i.sku, i.name, i.line || '', i.qty, ...(hide ? [] : [i.amount]), i.orders, (i.shops || []).join('; '), i.reason])];
        const blob = new Blob([rows.map(r => r.map(cell).join(',')).join('\n')], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `PPG-vs-sundries-${st.view}-${String(st.opts.periodLabel || 'report').replace(/[^a-z0-9]+/gi, '-')}.csv`;
        a.click(); URL.revokeObjectURL(a.href);
    }

    function render(el, data, opts) {
        if (!el) return;
        css();
        const prev = state.get(el);
        state.set(el, { data, opts: opts || {}, view: prev ? prev.view : 'shops', group: prev ? prev.group : 'all' });
        if (!el.dataset.ppgsBound) {
            el.dataset.ppgsBound = '1';
            el.addEventListener('click', async e => {
                const st = state.get(el); if (!st) return;
                const b = e.target.closest('button'); if (!b || !el.contains(b)) return;
                if (b.dataset.view) { st.view = b.dataset.view; draw(el); }
                else if (b.dataset.group) { st.group = b.dataset.group; draw(el); }
                else if (b.dataset.csv) csv(el);
                else if (b.dataset.to && typeof st.opts.onCorrect === 'function') {
                    b.disabled = true;
                    try { await st.opts.onCorrect(b.dataset.sku, b.dataset.to); } finally { b.disabled = false; }
                }
            });
        }
        draw(el);
    }

    function message(el, text) {
        if (!el) return;
        css();
        el.innerHTML = `<section class="ppgs"><div class="ppgs-head"><h3>PPG paint lines vs sundries</h3></div><p class="ppgs-empty">${esc(text)}</p></section>`;
    }

    /** Shop console: load with the same filters as the rest of the Reports screen. */
    async function loadStore(params, periodLabel) {
        const el = document.getElementById('ppg-split');
        // The store's own globals (see insights.js): lexical, so not on window.
        if (!el || typeof state === 'undefined' || typeof apiFetch !== 'function') return;
        const shopSel = document.getElementById('rep-shop');
        const shopLabel = shopSel && shopSel.options[shopSel.selectedIndex] ? shopSel.options[shopSel.selectedIndex].text : '';
        message(el, 'Loading…');
        try {
            const resp = await apiFetch(`/store/${state.slug}/reports/ppg-split?${params}`);
            if (!resp.ok) { el.innerHTML = ''; return; }
            render(el, await resp.json(), { periodLabel, shopLabel });
        } catch (_) {
            message(el, 'The PPG and sundries split could not be loaded. Refresh to try again.');
        }
    }

    window.PPGS = { render, message, loadStore };
})();
