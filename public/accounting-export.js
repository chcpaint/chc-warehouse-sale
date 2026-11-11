/**
 * public/accounting-export.js -- the "Accounting export" panel, shared by the
 * shop Reports screen and CHC Reports.
 *
 *   ACX.toggle(container, { getFilters: () => URLSearchParams, fetchCsv: query => Promise<Response>, supplier })
 *
 * The panel asks for the format (QuickBooks Online, Xero, CSV), the account
 * names to post PPG paint, sundries and fees to, the tax code, payment terms
 * and date format, then downloads the file. Choices are remembered in this
 * browser only.
 */
(function () {
    'use strict';
    const KEY = 'rai_acct_export';
    const esc = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const DEFAULTS = { format: 'qbo', detail: 'summary', ppg_account: 'Paint and Materials', sundries_account: 'Shop Supplies', fees_account: 'Freight and Delivery',
        tax_code: 'HST ON', fees_tax_code: 'Exempt', due_days: '30', date_format: 'dd/mm/yyyy' };
    const load = () => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch (_) { return { ...DEFAULTS }; } };
    const save = v => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (_) { /* private window */ } };

    function field(id, label, value, extra = '') {
        return `<div><label for="${id}" class="block text-xs font-semibold text-gray-500 mb-1">${label}</label>
            <input id="${id}" value="${esc(value)}" maxlength="100" class="w-full px-3 py-2 border rounded-lg text-sm" ${extra}></div>`;
    }

    function toggle(container, opts) {
        if (!container) return;
        if (!container.classList.contains('hidden') && container.dataset.open === '1') { container.classList.add('hidden'); container.dataset.open = ''; return; }
        const v = load();
        container.dataset.open = '1';
        container.classList.remove('hidden');
        container.innerHTML = `<div class="bg-white rounded-xl shadow-sm border p-4">
            <div class="flex flex-wrap justify-between items-baseline gap-2 mb-3">
                <p class="font-semibold text-gray-800">Accounting export</p>
                <p class="text-xs text-gray-500">Shipped orders in the shop and period above, as supplier bills from ${esc(opts.supplier || 'your distributor')}.</p>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div><label for="acx-format" class="block text-xs font-semibold text-gray-500 mb-1">For</label>
                    <select id="acx-format" class="w-full px-3 py-2 border rounded-lg text-sm bg-white">
                        <option value="qbo">QuickBooks Online</option><option value="xero">Xero</option><option value="csv">Other (CSV, e.g. Sage)</option></select></div>
                <div><label for="acx-detail" class="block text-xs font-semibold text-gray-500 mb-1">Lines</label>
                    <select id="acx-detail" class="w-full px-3 py-2 border rounded-lg text-sm bg-white">
                        <option value="summary">One per account (PPG, sundries, fees)</option><option value="items">One per item</option></select></div>
                ${field('acx-due', 'Payment terms (days)', v.due_days, 'type="number" min="0" max="365"')}
                <div><label for="acx-date" class="block text-xs font-semibold text-gray-500 mb-1">Date format</label>
                    <select id="acx-date" class="w-full px-3 py-2 border rounded-lg text-sm bg-white">
                        <option value="dd/mm/yyyy">dd/mm/yyyy (Canada)</option><option value="mm/dd/yyyy">mm/dd/yyyy (US)</option><option value="yyyy-mm-dd">yyyy-mm-dd</option></select></div>
                ${field('acx-ppg', 'Account for PPG paint lines', v.ppg_account)}
                ${field('acx-sun', 'Account for sundries', v.sundries_account)}
                ${field('acx-fees', 'Account for delivery and fuel fees', v.fees_account)}
                <div class="grid grid-cols-2 gap-2">${field('acx-tax', 'Tax code', v.tax_code)}${field('acx-ftax', 'Tax code on fees', v.fees_tax_code)}</div>
            </div>
            <p class="text-xs text-gray-400 mt-2">Use the account and tax code names exactly as they are in your accounting software. QuickBooks: Expenses &gt; Bills &gt; Import, choose "Exclusive of tax"; it suggests up to 100 bills per file. Xero: Business &gt; Bills to pay &gt; Import. Each shop is a "Shop" tracking option in Xero.</p>
            <div class="flex flex-wrap items-center gap-3 mt-3">
                <button type="button" id="acx-go" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm"><i class="fas fa-file-export mr-1"></i>Download</button>
                <span id="acx-note" class="text-sm text-gray-600" aria-live="polite"></span>
            </div>
        </div>`;
        container.querySelector('#acx-format').value = v.format;
        container.querySelector('#acx-detail').value = v.detail;
        container.querySelector('#acx-date').value = v.date_format;
        container.querySelector('#acx-go').addEventListener('click', () => run(container, opts));
    }

    async function run(container, opts) {
        const val = id => container.querySelector(id).value.trim();
        const v = { format: val('#acx-format'), detail: val('#acx-detail'), due_days: val('#acx-due'), date_format: val('#acx-date'),
            ppg_account: val('#acx-ppg'), sundries_account: val('#acx-sun'), fees_account: val('#acx-fees'), tax_code: val('#acx-tax'), fees_tax_code: val('#acx-ftax') };
        save(v);
        const q = opts.getFilters ? opts.getFilters() : new URLSearchParams();
        for (const [k, x] of Object.entries(v)) q.set(k, x);
        const note = container.querySelector('#acx-note');
        const btn = container.querySelector('#acx-go');
        btn.disabled = true; note.textContent = 'Building…';
        try {
            const r = await opts.fetchCsv(q.toString());
            if (!r.ok) { const d = await r.json().catch(() => ({})); note.textContent = d.error || 'Could not build the export.'; return; }
            const name = ((r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/) || [])[1] || 'bills.csv';
            const count = Number(r.headers.get('X-Bill-Count') || 0);
            let skipped = {}; try { skipped = JSON.parse(r.headers.get('X-Skipped') || '{}'); } catch (_) { /* optional */ }
            const blob = await r.blob();
            const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href);
            const extra = [skipped.not_shipped ? `${skipped.not_shipped} order(s) not shipped yet were left out` : '',
                skipped.unpriced_lines ? `${skipped.unpriced_lines} line(s) still to be priced were left out` : ''].filter(Boolean).join('; ');
            note.textContent = `${count} bill(s) downloaded.${extra ? ' ' + extra + '.' : ''}${v.format === 'qbo' && count > 100 ? ' QuickBooks suggests importing 100 at a time: choose a shorter period.' : ''}`;
        } catch (_) {
            note.textContent = 'Could not build the export. Try again.';
        } finally { btn.disabled = false; }
    }

    window.ACX = { toggle };
})();
