/**
 * public/kit-submissions.js
 *
 * The "Insurance Kits" screen of the sales portal (the `kit_submissions`
 * module): pick a repair kit, enter the repair order and claim, generate a
 * numbered PDF to load into Mitchell / CCC ONE / Audatex, and find every
 * earlier one again under "Saved submissions".
 *
 * Loaded by store.html only for companies that have the module on. It renders
 * into #tab-kitsub and talks to /api/store/:slug/kit-submissions.
 */
(function () {
    'use strict';

    var ctx = null;          // { apiBase, slug, getToken, getUser, getLocation, mount }
    var st = {
        kits: [], allowOverrides: true, preview: null, loaded: false,
        busy: false, search: '', status: '', list: [], total: 0, banner: null
    };

    function esc(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; });
    }
    function money(n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function qty(n) { var v = Number(n || 0); return Number.isInteger(v) ? String(v) : String(Math.round(v * 10000) / 10000); }
    function api(path, opts) {
        opts = opts || {};
        return fetch(ctx.apiBase + '/store/' + ctx.slug + '/kit-submissions' + path, {
            method: opts.method || 'GET',
            headers: Object.assign({ 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ctx.getToken() }, opts.headers || {}),
            body: opts.body ? JSON.stringify(opts.body) : undefined
        });
    }
    function $(id) { return document.getElementById(id); }

    // ------------------------------------------------------------
    // Data
    // ------------------------------------------------------------
    function loadKits() {
        return api('/kits').then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
            .then(function (x) {
                if (!x.ok) throw new Error(x.d.error || 'Could not load kits.');
                st.kits = x.d.kits || [];
                st.allowOverrides = x.d.allow_line_overrides !== false;
            });
    }
    function loadList() {
        var qs = '?limit=100' + (st.search ? '&q=' + encodeURIComponent(st.search) : '') + (st.status ? '&status=' + st.status : '');
        return api(qs).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
            .then(function (x) {
                if (!x.ok) throw new Error(x.d.error || 'Could not load saved submissions.');
                st.list = x.d.submissions || []; st.total = x.d.total || 0;
            });
    }
    function loadPreview(kitId, mult) {
        if (!kitId) { st.preview = null; return Promise.resolve(); }
        return api('/kits/' + kitId + '/preview?multiplier=' + encodeURIComponent(mult || 1))
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
            .then(function (x) {
                if (!x.ok) throw new Error(x.d.error || 'Could not preview that kit.');
                st.preview = x.d;
            });
    }

    // ------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------
    function banner() {
        if (!st.banner) return '';
        var b = st.banner;
        var cls = b.kind === 'ok' ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800';
        var extra = b.id ? ' <button type="button" class="underline font-semibold ml-1" data-ks-pdf="' + esc(b.id) + '" data-no="' + esc(b.no) + '">Open the PDF</button>' +
            ' <span class="text-gray-400">&middot;</span> <button type="button" class="underline font-semibold" data-ks-dl="' + esc(b.id) + '" data-no="' + esc(b.no) + '">Download</button>' : '';
        return '<div class="mb-4 rounded-lg border px-4 py-3 text-sm ' + cls + '" role="status">' + esc(b.text) + extra + '</div>';
    }

    function render() {
        if (!ctx || !ctx.mount) return;
        var user = ctx.getUser && ctx.getUser();
        var signedIn = !!(user && user.name);
        var p = st.preview;
        var selected = ($('ks-kit') && $('ks-kit').value) || '';
        var mult = ($('ks-mult') && $('ks-mult').value) || '1';
        var keep = {};
        ['ks-ro', 'ks-claim', 'ks-insurer', 'ks-vehicle', 'ks-vin', 'ks-notes', 'ks-name'].forEach(function (id) { var e = $(id); if (e) keep[id] = e.value; });

        var kitOptions = '<option value="">Choose a kit&hellip;</option>' + st.kits.map(function (k) {
            var label = k.name + (k.ready ? '' : ' (not set up for your shop yet)');
            return '<option value="' + esc(k.id) + '"' + (k.id === selected ? ' selected' : '') + (k.ready ? '' : ' disabled') + '>' + esc(label) + '</option>';
        }).join('');

        var table = '';
        if (p) {
            if (p.blocked) {
                table = '<div class="mt-4 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">' + esc(p.blocked_reason || 'This kit cannot be submitted yet.') + '</div>';
            } else {
                table = '<div class="mt-4 overflow-x-auto"><table class="w-full text-sm"><thead><tr class="text-left text-xs uppercase text-gray-500 border-b">' +
                    '<th class="py-2 pr-2">Brand</th><th class="py-2 pr-2">Part number</th><th class="py-2 pr-2">Description</th>' +
                    '<th class="py-2 pr-2 text-right">Qty</th><th class="py-2 pr-2 text-right">Unit</th><th class="py-2 text-right">Extended</th>' +
                    (st.allowOverrides ? '<th class="py-2 pl-2 text-center">Include</th>' : '') + '</tr></thead><tbody>' +
                    p.lines.map(function (l) {
                        return '<tr class="border-b" data-line="' + esc(l.kit_item_id) + '" data-unit="' + esc(l.unit_price) + '">' +
                            '<td class="py-2 pr-2 text-gray-600">' + esc(l.brand || '—') + '</td>' +
                            '<td class="py-2 pr-2 font-mono text-xs">' + esc(l.sku || '') + '</td>' +
                            '<td class="py-2 pr-2">' + esc(l.name) + '</td>' +
                            '<td class="py-2 pr-2 text-right">' + (st.allowOverrides
                                ? '<input type="number" step="any" min="0" value="' + esc(qty(l.quantity)) + '" aria-label="Quantity for ' + esc(l.sku || l.name) + '" class="ks-qty w-20 px-2 py-1 border rounded text-right">'
                                : esc(qty(l.quantity))) + ' <span class="text-xs text-gray-400">' + esc(l.unit || 'each') + '</span></td>' +
                            '<td class="py-2 pr-2 text-right">' + money(l.unit_price) + '</td>' +
                            '<td class="py-2 text-right font-semibold ks-ext">' + money(l.line_cost) + '</td>' +
                            (st.allowOverrides ? '<td class="py-2 pl-2 text-center"><input type="checkbox" class="ks-inc" checked aria-label="Include ' + esc(l.sku || l.name) + '"></td>' : '') +
                            '</tr>';
                    }).join('') +
                    '</tbody><tfoot><tr><td colspan="5" class="py-3 text-right font-bold">Total</td><td class="py-3 text-right font-bold" id="ks-total">' + money(p.total) + '</td>' +
                    (st.allowOverrides ? '<td></td>' : '') + '</tr></tfoot></table></div>';
            }
        }

        var canGenerate = p && !p.blocked && !st.busy;

        var listRows = st.list.length ? st.list.map(function (s) {
            var badge = s.status === 'paid' ? 'bg-green-100 text-green-800' : (s.status === 'void' ? 'bg-gray-200 text-gray-600' : 'bg-blue-100 text-blue-800');
            var label = s.status === 'paid' ? 'Paid' : (s.status === 'void' ? 'Void' : 'Submitted');
            var date = s.created_at ? new Date(s.created_at).toLocaleDateString('en-CA') : '';
            var actions = '<button type="button" class="text-blue-700 hover:underline mr-3" data-ks-pdf="' + esc(s.id) + '" data-no="' + esc(s.submission_no) + '"><i class="fas fa-file-pdf mr-1"></i>PDF</button>' +
                '<button type="button" class="text-blue-700 hover:underline mr-3" data-ks-dl="' + esc(s.id) + '" data-no="' + esc(s.submission_no) + '"><i class="fas fa-download mr-1"></i>Save</button>' +
                (s.status === 'issued' ? '<button type="button" class="text-green-700 hover:underline mr-3" data-ks-paid="' + esc(s.id) + '">Mark paid</button>' : '') +
                (s.status === 'paid' ? '<button type="button" class="text-gray-500 hover:underline mr-3" data-ks-reopen="' + esc(s.id) + '">Undo paid</button>' : '') +
                (s.status !== 'void' ? '<button type="button" class="text-red-600 hover:underline" data-ks-void="' + esc(s.id) + '" data-no="' + esc(s.submission_no) + '">Void</button>' : '');
            return '<tr class="border-b align-top' + (s.status === 'void' ? ' text-gray-400' : '') + '">' +
                '<td class="py-2 pr-3 font-mono text-xs font-semibold">' + esc(s.submission_no) + '</td>' +
                '<td class="py-2 pr-3">' + esc(s.ro_number) + (s.claim_no ? '<div class="text-xs text-gray-500">Claim ' + esc(s.claim_no) + '</div>' : '') + '</td>' +
                '<td class="py-2 pr-3">' + esc(s.kit_name) + (s.insurer ? '<div class="text-xs text-gray-500">' + esc(s.insurer) + '</div>' : '') + '</td>' +
                '<td class="py-2 pr-3 text-right">' + money(s.total_amount) + '</td>' +
                '<td class="py-2 pr-3 whitespace-nowrap">' + esc(date) + '</td>' +
                '<td class="py-2 pr-3"><span class="px-2 py-0.5 rounded-full text-xs font-semibold ' + badge + '">' + label + '</span>' +
                (s.status === 'void' && s.void_reason ? '<div class="text-xs text-gray-500 mt-1">' + esc(s.void_reason) + '</div>' : '') + '</td>' +
                '<td class="py-2 text-sm whitespace-nowrap">' + actions + '</td></tr>';
        }).join('') : '<tr><td colspan="7" class="py-6 text-center text-gray-500">Nothing saved yet. Your first submission will appear here.</td></tr>';

        ctx.mount.innerHTML =
            '<button onclick="showTab(\'products\')" type="button" class="mb-3 text-blue-600 hover:underline text-sm"><i class="fas fa-arrow-left mr-1"></i>Back to Products</button>' +
            '<h2 class="text-2xl font-bold text-gray-800 mb-1"><i class="fas fa-file-invoice-dollar mr-2"></i>Insurance kit submissions</h2>' +
            '<p class="text-gray-500 mb-4">Pick a kit, add the repair order and claim, and get a numbered PDF itemizing its materials to load into Mitchell, CCC ONE or Audatex. Every one is saved below.</p>' +
            banner() +
            '<div class="bg-white rounded-xl shadow-sm border p-5 mb-6">' +
            '<h3 class="font-bold text-gray-800 mb-3">New submission</h3>' +
            (st.kits.length === 0 && st.loaded ? '<p class="text-sm text-gray-600">No kits have been set up for your shop yet. Ask CHC to turn on the kits you use.</p>' :
            '<div class="grid grid-cols-1 md:grid-cols-3 gap-3">' +
            '<div class="md:col-span-2"><label for="ks-kit" class="block text-xs font-semibold text-gray-600 mb-1">Kit</label><select id="ks-kit" class="w-full px-3 py-2 border rounded-lg text-sm">' + kitOptions + '</select></div>' +
            '<div><label for="ks-mult" class="block text-xs font-semibold text-gray-600 mb-1">Number of times used (e.g. two doors = 2)</label><input id="ks-mult" type="number" min="0.0001" max="100" step="any" value="' + esc(mult) + '" class="w-full px-3 py-2 border rounded-lg text-sm"></div>' +
            '<div><label for="ks-ro" class="block text-xs font-semibold text-gray-600 mb-1">Repair order # <span class="text-red-600">*</span></label><input id="ks-ro" maxlength="60" class="w-full px-3 py-2 border rounded-lg text-sm" placeholder="e.g. 10482"></div>' +
            '<div><label for="ks-claim" class="block text-xs font-semibold text-gray-600 mb-1">Claim #</label><input id="ks-claim" maxlength="60" class="w-full px-3 py-2 border rounded-lg text-sm"></div>' +
            '<div><label for="ks-insurer" class="block text-xs font-semibold text-gray-600 mb-1">Insurer</label><input id="ks-insurer" maxlength="120" class="w-full px-3 py-2 border rounded-lg text-sm" placeholder="e.g. Intact"></div>' +
            '<div class="md:col-span-2"><label for="ks-vehicle" class="block text-xs font-semibold text-gray-600 mb-1">Vehicle</label><input id="ks-vehicle" maxlength="160" class="w-full px-3 py-2 border rounded-lg text-sm" placeholder="e.g. 2022 Honda Civic"></div>' +
            '<div><label for="ks-vin" class="block text-xs font-semibold text-gray-600 mb-1">VIN</label><input id="ks-vin" maxlength="20" class="w-full px-3 py-2 border rounded-lg text-sm font-mono"></div>' +
            '<div class="md:col-span-2"><label for="ks-notes" class="block text-xs font-semibold text-gray-600 mb-1">Notes for the estimator (printed on the PDF)</label><input id="ks-notes" maxlength="1000" class="w-full px-3 py-2 border rounded-lg text-sm"></div>' +
            (signedIn ? '' : '<div><label for="ks-name" class="block text-xs font-semibold text-gray-600 mb-1">Your name <span class="text-red-600">*</span></label><input id="ks-name" maxlength="80" class="w-full px-3 py-2 border rounded-lg text-sm"></div>') +
            '</div>' + table +
            '<div class="mt-4 flex items-center gap-3"><button type="button" id="ks-generate" class="bg-blue-700 hover:bg-blue-800 text-white font-semibold px-5 py-2.5 rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed"' + (canGenerate ? '' : ' disabled') + '>' +
            (st.busy ? '<i class="fas fa-spinner fa-spin mr-1"></i>Working&hellip;' : '<i class="fas fa-file-pdf mr-1"></i>Generate PDF') + '</button>' +
            '<span class="text-xs text-gray-500">A unique submission number is assigned to your shop and saved below.</span></div>') +
            '</div>' +
            '<div class="bg-white rounded-xl shadow-sm border p-5">' +
            '<div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3"><h3 class="font-bold text-gray-800">Saved submissions <span class="text-sm font-normal text-gray-500">(' + st.total + ')</span></h3>' +
            '<div class="flex gap-2"><input id="ks-search" type="search" value="' + esc(st.search) + '" placeholder="Search number, RO, claim&hellip;" aria-label="Search submissions" class="px-3 py-1.5 border rounded-lg text-sm w-48">' +
            '<select id="ks-status" aria-label="Filter by status" class="px-3 py-1.5 border rounded-lg text-sm"><option value="">All</option><option value="issued"' + (st.status === 'issued' ? ' selected' : '') + '>Submitted</option><option value="paid"' + (st.status === 'paid' ? ' selected' : '') + '>Paid</option><option value="void"' + (st.status === 'void' ? ' selected' : '') + '>Void</option></select></div></div>' +
            '<div class="overflow-x-auto"><table class="w-full text-sm"><thead><tr class="text-left text-xs uppercase text-gray-500 border-b"><th class="py-2 pr-3">Number</th><th class="py-2 pr-3">RO</th><th class="py-2 pr-3">Kit</th><th class="py-2 pr-3 text-right">Total</th><th class="py-2 pr-3">Date</th><th class="py-2 pr-3">Status</th><th class="py-2"></th></tr></thead><tbody>' + listRows + '</tbody></table></div></div>';

        Object.keys(keep).forEach(function (id) { var e = $(id); if (e) e.value = keep[id]; });
        wire();
    }

    function recalcTotals() {
        var total = 0;
        document.querySelectorAll('#tab-kitsub tr[data-line]').forEach(function (tr) {
            var inc = tr.querySelector('.ks-inc'), q = tr.querySelector('.ks-qty');
            var unit = Number(tr.getAttribute('data-unit') || 0);
            var n = q ? Number(q.value) : 0;
            var ext = (inc && !inc.checked) || !(n > 0) ? 0 : n * unit;
            var cell = tr.querySelector('.ks-ext'); if (cell) cell.textContent = money(ext);
            tr.style.opacity = inc && !inc.checked ? '0.45' : '';
            total += ext;
        });
        var t = $('ks-total'); if (t) t.textContent = money(total);
    }

    // ------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------
    function fail(msg) { st.banner = { kind: 'err', text: msg }; st.busy = false; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }

    function generate() {
        var p = st.preview; if (!p || p.blocked || st.busy) return;
        var ro = ($('ks-ro').value || '').trim();
        if (!ro) { $('ks-ro').focus(); return fail('Enter the repair order number.'); }
        var user = ctx.getUser && ctx.getUser();
        var nameEl = $('ks-name');
        var actor = nameEl ? nameEl.value.trim() : '';
        if (!user && !actor) { nameEl && nameEl.focus(); return fail('Enter your name so the PDF shows who prepared it.'); }

        var lines = [];
        if (st.allowOverrides) {
            document.querySelectorAll('#tab-kitsub tr[data-line]').forEach(function (tr) {
                var inc = tr.querySelector('.ks-inc'), q = tr.querySelector('.ks-qty');
                var id = tr.getAttribute('data-line');
                if (inc && !inc.checked) lines.push({ kit_item_id: id, skip: true });
                else if (q) lines.push({ kit_item_id: id, quantity: Number(q.value) });
            });
        }
        var loc = ctx.getLocation && ctx.getLocation();
        st.busy = true; st.banner = null; render();
        api('', { method: 'POST', body: {
            kit_id: $('ks-kit').value, multiplier: Number($('ks-mult').value) || 1, ro_number: ro,
            claim_no: $('ks-claim').value, insurer: $('ks-insurer').value, vehicle: $('ks-vehicle').value,
            vin: $('ks-vin').value, notes: $('ks-notes').value, actor_label: actor,
            location_id: loc && loc.id ? loc.id : undefined, lines: lines
        } }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
            .then(function (x) {
                if (!x.ok) return fail(x.d.error || 'Could not create the submission.');
                var s = x.d.submission;
                st.busy = false;
                st.banner = { kind: 'ok', text: 'Saved as ' + s.submission_no + '.', id: s.id, no: s.submission_no };
                // Clear the job details but keep the kit chosen, ready for the next one.
                ['ks-ro', 'ks-claim', 'ks-insurer', 'ks-vehicle', 'ks-vin', 'ks-notes'].forEach(function (id) { var e = $(id); if (e) e.value = ''; });
                return loadList().then(function () { render(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
            })
            .catch(function (e) { fail(e.message || 'Could not create the submission.'); });
    }

    /** Authenticated fetch of the PDF, then open it (or save it). */
    function openPdf(id, no, download) {
        // Open the tab synchronously so pop-up blockers allow it; point it once the PDF arrives.
        var win = download ? null : window.open('', '_blank');
        fetch(ctx.apiBase + '/store/' + ctx.slug + '/kit-submissions/' + id + '/pdf', { headers: { 'Authorization': 'Bearer ' + ctx.getToken() } })
            .then(function (r) { if (!r.ok) throw new Error('Could not build the PDF.'); return r.blob(); })
            .then(function (blob) {
                var url = URL.createObjectURL(blob);
                if (download) {
                    var a = document.createElement('a'); a.href = url; a.download = no + '.pdf';
                    document.body.appendChild(a); a.click(); a.remove();
                } else if (win) { win.location.href = url; }
                else { window.location.href = url; }
                setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
            })
            .catch(function (e) { if (win) win.close(); fail(e.message); });
    }

    function setStatus(id, status, reason) {
        api('/' + id, { method: 'PATCH', body: { status: status, void_reason: reason } })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
            .then(function (x) { if (!x.ok) throw new Error(x.d.error || 'Could not update that submission.'); return loadList(); })
            .then(function () { render(); })
            .catch(function (e) { fail(e.message); });
    }

    function wire() {
        var kit = $('ks-kit'), mult = $('ks-mult');
        function refresh() {
            loadPreview(kit.value, mult.value).then(render).catch(function (e) { st.preview = null; fail(e.message); });
        }
        if (kit) kit.addEventListener('change', refresh);
        if (mult) mult.addEventListener('change', refresh);
        var gen = $('ks-generate'); if (gen) gen.addEventListener('click', generate);
        ctx.mount.querySelectorAll('.ks-qty,.ks-inc').forEach(function (el) { el.addEventListener('input', recalcTotals); el.addEventListener('change', recalcTotals); });

        var search = $('ks-search'), timer = null;
        if (search) search.addEventListener('input', function () {
            clearTimeout(timer);
            timer = setTimeout(function () {
                st.search = search.value.trim();
                loadList().then(function () { render(); var s2 = $('ks-search'); if (s2) { s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); } });
            }, 300);
        });
        var status = $('ks-status'); if (status) status.addEventListener('change', function () { st.status = status.value; loadList().then(render); });

        ctx.mount.querySelectorAll('[data-ks-pdf]').forEach(function (b) { b.addEventListener('click', function () { openPdf(b.getAttribute('data-ks-pdf'), b.getAttribute('data-no'), false); }); });
        ctx.mount.querySelectorAll('[data-ks-dl]').forEach(function (b) { b.addEventListener('click', function () { openPdf(b.getAttribute('data-ks-dl'), b.getAttribute('data-no'), true); }); });
        ctx.mount.querySelectorAll('[data-ks-paid]').forEach(function (b) { b.addEventListener('click', function () { setStatus(b.getAttribute('data-ks-paid'), 'paid'); }); });
        ctx.mount.querySelectorAll('[data-ks-reopen]').forEach(function (b) { b.addEventListener('click', function () { setStatus(b.getAttribute('data-ks-reopen'), 'issued'); }); });
        ctx.mount.querySelectorAll('[data-ks-void]').forEach(function (b) {
            b.addEventListener('click', function () {
                var why = window.prompt('Void ' + b.getAttribute('data-no') + '? Its number stays on record. Why is it being voided?');
                if (why && why.trim()) setStatus(b.getAttribute('data-ks-void'), 'void', why.trim());
            });
        });
    }

    // ------------------------------------------------------------
    // Public surface
    // ------------------------------------------------------------
    window.KITSUB = {
        init: function (c) { ctx = c; return !!(c && c.mount); },
        show: function () {
            if (!ctx) return;
            st.banner = null;
            render();
            Promise.all([loadKits(), loadList()])
                .then(function () { st.loaded = true; render(); })
                .catch(function (e) { st.loaded = true; fail(e.message); });
        }
    };
})();
