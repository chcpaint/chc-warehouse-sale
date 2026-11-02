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

    var ctx = null;          // { apiBase, slug, getToken, getUser, getLocation, mount, addMount, editMount }
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
                ad.allowed = x.d.allow_add_kit !== false;
                st.allowEditKits = x.d.allow_edit_kits === true;
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
                    '</tbody><tfoot>' +
                    '<tr><td colspan="5" class="pt-3 text-right text-gray-600">Subtotal</td><td class="pt-3 text-right" id="ks-sub">' + money(p.subtotal != null ? p.subtotal : p.total) + '</td>' + (st.allowOverrides ? '<td></td>' : '') + '</tr>' +
                    '<tr><td colspan="5" class="py-1 text-right text-gray-600" id="ks-taxlabel">' + esc(taxText(p)) + '</td><td class="py-1 text-right" id="ks-tax">' + money(p.tax_amount || 0) + '</td>' + (st.allowOverrides ? '<td></td>' : '') + '</tr>' +
                    '<tr><td colspan="5" class="py-2 text-right font-bold">Total</td><td class="py-2 text-right font-bold" id="ks-total">' + money(p.grand_total != null ? p.grand_total : p.total) + '</td>' +
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
            '<div class="flex items-start justify-between gap-3 flex-wrap"><h2 class="text-2xl font-bold text-gray-800 mb-1"><i class="fas fa-file-invoice-dollar mr-2"></i>Insurance kit submissions</h2>' +
            '<div class="flex gap-2">' + (st.allowEditKits ? '<button type="button" onclick="showTab(\'kitedit\')" class="text-sm font-semibold text-blue-700 border border-blue-200 rounded-lg px-3 py-1.5 hover:bg-blue-50"><i class="fas fa-pen-to-square mr-1"></i>Edit kits</button>' : '') +
            (ad.allowed ? '<button type="button" onclick="showTab(\'kitadd\')" class="text-sm font-semibold text-blue-700 border border-blue-200 rounded-lg px-3 py-1.5 hover:bg-blue-50"><i class="fas fa-plus mr-1"></i>Add kit</button>' : '') + '</div></div>' +
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

    function taxText(p) {
        if (p.tax_label === 'Tax exempt') return 'Tax exempt (0%)';
        var pct = Math.round(Number(p.tax_rate || 0) * 10000) / 100;
        return (p.tax_label || 'Tax') + ' (' + pct + '%)';
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
        var sub = Math.round(total * 100) / 100;
        var tax = Math.round((sub * Number((st.preview && st.preview.tax_rate) || 0) + Number.EPSILON) * 100) / 100;
        var a = $('ks-sub'); if (a) a.textContent = money(sub);
        var b = $('ks-tax'); if (b) b.textContent = money(tax);
        var t = $('ks-total'); if (t) t.textContent = money(Math.round((sub + tax) * 100) / 100);
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
    // Add Kit: build a kit of the shop's own
    // ------------------------------------------------------------
    var ad = { name: '', desc: '', lines: [], results: [], q: '', searching: false, busy: false, banner: null, mine: [], allowed: true };

    function adRoot() { return ctx && ctx.addMount; }
    function adFail(msg) { ad.banner = { kind: 'err', text: msg }; ad.busy = false; renderAdd(); window.scrollTo({ top: 0, behavior: 'smooth' }); }

    function loadMine() {
        return loadKits().then(function () {
            ad.mine = st.kits.filter(function (k) { return k.own; });
        });
    }

    function renderAdd() {
        var root = adRoot(); if (!root) return;
        var cls = ad.banner ? (ad.banner.kind === 'ok' ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800') : '';
        var mine = ad.mine.length ? ad.mine.map(function (k) {
            return '<li class="flex items-center justify-between py-2 border-b last:border-0"><span><span class="font-semibold text-gray-800">' + esc(k.name) + '</span> <span class="text-xs text-gray-500">' + esc(k.line_count) + ' part' + (k.line_count === 1 ? '' : 's') + '</span></span>' +
                '<button type="button" class="text-red-600 hover:underline text-sm" data-ka-remove="' + esc(k.id) + '" data-name="' + esc(k.name) + '">Remove</button></li>';
        }).join('') : '<li class="py-3 text-sm text-gray-500">You have not added any kits of your own yet.</li>';

        root.innerHTML =
            '<button onclick="showTab(\'kitsub\')" type="button" class="mb-3 text-blue-600 hover:underline text-sm"><i class="fas fa-arrow-left mr-1"></i>Back to Insurance Kits</button>' +
            '<h2 class="text-2xl font-bold text-gray-800 mb-1"><i class="fas fa-plus-circle mr-2"></i>Add a kit</h2>' +
            '<p class="text-gray-500 mb-4">Name your kit, search for the parts it uses and set the quantity of each. It shows up in your Insurance Kits list right away.</p>' +
            (ad.banner ? '<div class="mb-4 rounded-lg border px-4 py-3 text-sm ' + cls + '" role="status">' + esc(ad.banner.text) +
                (ad.banner.kind === 'ok' ? ' <button type="button" class="underline font-semibold ml-1" onclick="showTab(\'kitsub\')">Use it now</button>' : '') + '</div>' : '') +
            (ad.allowed ? (
            '<div class="bg-white rounded-xl shadow-sm border p-5 mb-6">' +
            '<div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">' +
            '<div class="md:col-span-1"><label for="ka-name" class="block text-xs font-semibold text-gray-600 mb-1">Kit name <span class="text-red-600">*</span></label><input id="ka-name" maxlength="120" value="' + esc(ad.name) + '" class="w-full px-3 py-2 border rounded-lg text-sm" placeholder="e.g. Door skin repair"></div>' +
            '<div class="md:col-span-2"><label for="ka-desc" class="block text-xs font-semibold text-gray-600 mb-1">Description (optional)</label><input id="ka-desc" maxlength="500" value="' + esc(ad.desc) + '" class="w-full px-3 py-2 border rounded-lg text-sm"></div></div>' +
            '<label for="ka-search" class="block text-xs font-semibold text-gray-600 mb-1">Find a part (part number or name)</label>' +
            '<input id="ka-search" type="search" autocomplete="off" value="' + esc(ad.q) + '" class="w-full md:w-96 px-3 py-2 border rounded-lg text-sm" placeholder="e.g. 05915 or body filler">' +
            '<div id="ka-results" class="mt-2"></div>' +
            '<h3 class="font-bold text-gray-800 mt-5 mb-2">Parts in this kit <span id="ka-count" class="text-sm font-normal text-gray-500"></span></h3>' +
            '<div id="ka-lines" class="overflow-x-auto"></div>' +
            '<div class="mt-4"><button type="button" id="ka-save" class="bg-blue-700 hover:bg-blue-800 text-white font-semibold px-5 py-2.5 rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed">' +
            (ad.busy ? '<i class="fas fa-spinner fa-spin mr-1"></i>Saving&hellip;' : '<i class="fas fa-save mr-1"></i>Save kit') + '</button></div></div>'
            ) : '<div class="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800 mb-6">Adding kits is not turned on for your shop. Ask CHC to switch it on.</div>') +
            '<div class="bg-white rounded-xl shadow-sm border p-5"><h3 class="font-bold text-gray-800 mb-2">Your own kits</h3><ul>' + mine + '</ul></div>';
        if (ad.allowed) { updateResults(); updateLines(); }
        wireAdd();
    }

    function updateResults() {
        var host = $('ka-results'); if (!host) return;
        if (ad.searching) { host.innerHTML = '<p class="text-sm text-gray-500"><i class="fas fa-spinner fa-spin mr-1"></i>Searching&hellip;</p>'; return; }
        if (ad.q.length < 2) { host.innerHTML = ''; return; }
        if (!ad.results.length) { host.innerHTML = '<p class="text-sm text-gray-500">Nothing matches. Check the part number, or ask CHC to add the part.</p>'; return; }
        host.innerHTML = '<ul class="border rounded-lg divide-y max-h-64 overflow-y-auto">' + ad.results.map(function (p, i) {
            var have = ad.lines.some(function (l) { return skuKey(l.sku) === skuKey(p.sku); });
            return '<li><button type="button" data-ka-add="' + i + '" class="w-full text-left px-3 py-2 hover:bg-blue-50 flex items-center justify-between gap-3 disabled:opacity-50"' + (have ? ' disabled' : '') + '>' +
                '<span><span class="font-mono text-xs font-semibold">' + esc(p.sku) + '</span> <span class="text-sm">' + esc(p.name) + '</span>' + (p.brand ? ' <span class="text-xs text-gray-500">' + esc(p.brand) + '</span>' : '') + '</span>' +
                '<span class="text-xs ' + (have ? 'text-gray-400' : 'text-blue-700 font-semibold') + '">' + (have ? 'Added' : '+ Add') + '</span></button></li>';
        }).join('') + '</ul>';
        host.querySelectorAll('[data-ka-add]').forEach(function (b) {
            b.addEventListener('click', function () { addLine(ad.results[Number(b.getAttribute('data-ka-add'))]); });
        });
    }

    function skuKey(v) { return String(v == null ? '' : v).replace(/[^A-Za-z0-9]/g, '').toUpperCase(); }

    function updateLines() {
        var host = $('ka-lines'), count = $('ka-count'), save = $('ka-save');
        if (!host) return;
        if (count) count.textContent = ad.lines.length ? '(' + ad.lines.length + ')' : '';
        if (save) save.disabled = ad.busy || !ad.lines.length;
        if (!ad.lines.length) { host.innerHTML = '<p class="text-sm text-gray-500">No parts yet. Search above and click a part to add it.</p>'; return; }
        host.innerHTML = '<table class="w-full text-sm"><thead><tr class="text-left text-xs uppercase text-gray-500 border-b"><th class="py-2 pr-2">Part number</th><th class="py-2 pr-2">Description</th><th class="py-2 pr-2 text-right">Quantity</th><th class="py-2"></th></tr></thead><tbody>' +
            ad.lines.map(function (l, i) {
                return '<tr class="border-b"><td class="py-2 pr-2 font-mono text-xs">' + esc(l.sku) + '</td><td class="py-2 pr-2">' + esc(l.name) + '</td>' +
                    '<td class="py-2 pr-2 text-right"><input type="number" step="any" min="0" value="' + esc(qty(l.quantity)) + '" data-ka-qty="' + i + '" aria-label="Quantity for ' + esc(l.sku) + '" class="w-24 px-2 py-1 border rounded text-right"> <span class="text-xs text-gray-400">' + esc(l.unit || 'each') + '</span></td>' +
                    '<td class="py-2 text-right"><button type="button" class="text-red-600 hover:underline" data-ka-del="' + i + '" aria-label="Remove ' + esc(l.sku) + '">Remove</button></td></tr>';
            }).join('') + '</tbody></table>';
        host.querySelectorAll('[data-ka-qty]').forEach(function (el) {
            el.addEventListener('input', function () { ad.lines[Number(el.getAttribute('data-ka-qty'))].quantity = Number(el.value); });
        });
        host.querySelectorAll('[data-ka-del]').forEach(function (b) {
            b.addEventListener('click', function () { ad.lines.splice(Number(b.getAttribute('data-ka-del')), 1); updateLines(); updateResults(); });
        });
    }

    function addLine(p) {
        if (!p || ad.lines.some(function (l) { return skuKey(l.sku) === skuKey(p.sku); })) return;
        ad.lines.push({ sku: p.sku, name: p.name, unit: p.unit || 'each', quantity: 1 });
        updateLines(); updateResults();
    }

    function saveKit() {
        if (ad.busy) return;
        ad.name = ($('ka-name').value || '').trim(); ad.desc = ($('ka-desc').value || '').trim();
        if (!ad.name) { $('ka-name').focus(); return adFail('Give the kit a name.'); }
        if (!ad.lines.length) return adFail('Add at least one part.');
        for (var i = 0; i < ad.lines.length; i++) {
            if (!(Number(ad.lines[i].quantity) > 0)) return adFail('Set a quantity above zero for ' + ad.lines[i].sku + '.');
        }
        ad.busy = true; ad.banner = null; renderAdd();
        api('/my-kits', { method: 'POST', body: { name: ad.name, description: ad.desc, lines: ad.lines.map(function (l) { return { sku: l.sku, quantity: Number(l.quantity), unit: l.unit }; }) } })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
            .then(function (x) {
                if (!x.ok) return adFail(x.d.error || 'Could not save that kit.');
                var nm = x.d.kit.name;
                ad.name = ''; ad.desc = ''; ad.lines = []; ad.results = []; ad.q = ''; ad.busy = false;
                ad.banner = { kind: 'ok', text: '"' + nm + '" is saved and ready in your kit list.' };
                return loadMine().then(function () { renderAdd(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
            })
            .catch(function (e) { adFail(e.message || 'Could not save that kit.'); });
    }

    function wireAdd() {
        var root = adRoot(); if (!root) return;
        var save = $('ka-save'); if (save) save.addEventListener('click', saveKit);
        var search = $('ka-search'), timer = null;
        if (search) search.addEventListener('input', function () {
            ad.q = search.value.trim();
            clearTimeout(timer);
            if (ad.q.length < 2) { ad.results = []; ad.searching = false; updateResults(); return; }
            ad.searching = true; updateResults();
            timer = setTimeout(function () {
                var asked = ad.q;
                api('/parts?q=' + encodeURIComponent(asked))
                    .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
                    .then(function (x) {
                        if (asked !== ad.q) return;
                        ad.searching = false;
                        ad.results = x.ok ? (x.d.parts || []) : [];
                        if (!x.ok) ad.banner = { kind: 'err', text: x.d.error || 'Could not search parts.' };
                        updateResults();
                    })
                    .catch(function () { ad.searching = false; ad.results = []; updateResults(); });
            }, 300);
        });
        root.querySelectorAll('[data-ka-remove]').forEach(function (b) {
            b.addEventListener('click', function () {
                if (!window.confirm('Remove "' + b.getAttribute('data-name') + '" from your kits? Past submissions keep their record.')) return;
                api('/my-kits/' + b.getAttribute('data-ka-remove'), { method: 'DELETE' })
                    .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
                    .then(function (x) { if (!x.ok) throw new Error(x.d.error || 'Could not remove that kit.'); ad.banner = { kind: 'ok', text: x.d.message }; return loadMine(); })
                    .then(renderAdd)
                    .catch(function (e) { adFail(e.message); });
            });
        });
    }

    // ------------------------------------------------------------
    // Edit Kits: change the shop's own kits (parts, quantities, prices)
    // ------------------------------------------------------------
    var ed = { view: 'list', kit: null, lines: [], q: '', results: [], searching: false, busy: false, banner: null, allowed: false };

    function edRoot() { return ctx && ctx.editMount; }
    function edFail(msg) { ed.banner = { kind: 'err', text: msg }; ed.busy = false; if (ed.view === 'edit') renderEditor(); else renderEditList(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    function edBanner() {
        if (!ed.banner) return '';
        var cls = ed.banner.kind === 'ok' ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800';
        return '<div class="mb-4 rounded-lg border px-4 py-3 text-sm ' + cls + '" role="status">' + esc(ed.banner.text) + '</div>';
    }
    function jsonOf(r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); }

    function showEdit() {
        if (!ctx || !ctx.editMount) return;
        ed.view = 'list'; ed.banner = null; ed.kit = null;
        renderEditList();
        loadKits().then(function () { ed.allowed = !!st.allowEditKits; renderEditList(); })
            .catch(function (e) { edFail(e.message); });
    }

    function renderEditList() {
        var root = edRoot(); if (!root) return;
        var rows = st.kits.length ? st.kits.map(function (k) {
            var own = !!k.own;
            return '<li class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-3 border-b last:border-0">' +
                '<div><span class="font-semibold text-gray-800">' + esc(k.name) + '</span> ' +
                '<span class="text-xs px-2 py-0.5 rounded-full ' + (own ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-600') + '">' + (own ? 'Your kit' : 'CHC kit') + '</span>' +
                '<div class="text-xs text-gray-500">' + esc(k.line_count) + ' part' + (k.line_count === 1 ? '' : 's') + (k.estimated_total ? ' &middot; about ' + money(k.estimated_total) : '') + '</div></div>' +
                (own ? '<button type="button" class="bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold px-4 py-1.5 rounded-lg" data-ke-edit="' + esc(k.id) + '"><i class="fas fa-pen mr-1"></i>Edit</button>'
                     : '<button type="button" class="text-blue-700 border border-blue-200 hover:bg-blue-50 text-sm font-semibold px-4 py-1.5 rounded-lg" data-ke-copy="' + esc(k.id) + '" data-name="' + esc(k.name) + '"><i class="fas fa-copy mr-1"></i>Make my copy to edit</button>') +
                '</li>';
        }).join('') : '<li class="py-4 text-sm text-gray-500">No kits yet.</li>';
        root.innerHTML =
            '<button onclick="showTab(\'kitsub\')" type="button" class="mb-3 text-blue-600 hover:underline text-sm"><i class="fas fa-arrow-left mr-1"></i>Back to Insurance Kits</button>' +
            '<div class="flex items-start justify-between gap-3 flex-wrap"><h2 class="text-2xl font-bold text-gray-800 mb-1"><i class="fas fa-pen-to-square mr-2"></i>Edit kits</h2>' +
            '<button type="button" onclick="showTab(\'kitadd\')" class="text-sm font-semibold text-blue-700 border border-blue-200 rounded-lg px-3 py-1.5 hover:bg-blue-50"><i class="fas fa-plus mr-1"></i>Add kit</button></div>' +
            '<p class="text-gray-500 mb-4">Change the parts, quantities and prices in your kits. CHC kits are shared by everyone, so to change one you first make your own copy; the original stays as CHC set it.</p>' +
            edBanner() +
            (ed.allowed || !st.loaded ? '<div class="bg-white rounded-xl shadow-sm border p-5"><ul>' + rows + '</ul></div>'
                : '<div class="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">Editing kits is not turned on for your shop. Ask CHC to switch it on.</div>');
        root.querySelectorAll('[data-ke-edit]').forEach(function (b) { b.addEventListener('click', function () { openEditor(b.getAttribute('data-ke-edit')); }); });
        root.querySelectorAll('[data-ke-copy]').forEach(function (b) {
            b.addEventListener('click', function () {
                if (!window.confirm('Make your own copy of "' + b.getAttribute('data-name') + '"?\n\nYou can then change its parts, quantities and prices. The CHC original will be hidden from your list so you only see your version.')) return;
                b.disabled = true;
                api('/kits/' + b.getAttribute('data-ke-copy') + '/customize', { method: 'POST', body: {} })
                    .then(jsonOf)
                    .then(function (x) { if (!x.ok) throw new Error(x.d.error || 'Could not make your copy.'); return loadKits().then(function () { ed.banner = { kind: 'ok', text: 'Your copy is ready. Make your changes below.' }; return openEditor(x.d.kit.id, true); }); })
                    .catch(function (e) { edFail(e.message); });
            });
        });
    }

    function openEditor(kitId, keepBanner) {
        if (!keepBanner) ed.banner = null;
        return api('/my-kits/' + kitId).then(jsonOf).then(function (x) {
            if (!x.ok) throw new Error(x.d.error || 'Could not open that kit.');
            ed.view = 'edit';
            ed.kit = x.d.kit;
            ed.lines = x.d.lines.map(function (l) { l.touched = false; l.priceText = l.unit_price == null ? '' : String(l.unit_price); return l; });
            ed.q = ''; ed.results = [];
            renderEditor(); window.scrollTo({ top: 0, behavior: 'smooth' });
        }).catch(function (e) { edFail(e.message); });
    }

    function linePrice(l) {
        var t = String(l.priceText == null ? '' : l.priceText).trim();
        if (t === '') return l.touched ? (l.catalogue_price == null ? null : Number(l.catalogue_price)) : (l.unit_price == null ? null : Number(l.unit_price));
        var n = Number(t); return isFinite(n) ? n : null;
    }

    function renderEditor() {
        var root = edRoot(); if (!root) return;
        root.innerHTML =
            '<button type="button" id="ke-back" class="mb-3 text-blue-600 hover:underline text-sm"><i class="fas fa-arrow-left mr-1"></i>Back to all kits</button>' +
            '<h2 class="text-2xl font-bold text-gray-800 mb-1"><i class="fas fa-pen mr-2"></i>Edit kit</h2>' +
            '<p class="text-gray-500 mb-4">Change a quantity or price, remove a part, or add one, then save. A price you set applies to your shop only; clear it to go back to the standard price.</p>' +
            edBanner() +
            '<div class="bg-white rounded-xl shadow-sm border p-5">' +
            '<div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">' +
            '<div><label for="ke-name" class="block text-xs font-semibold text-gray-600 mb-1">Kit name <span class="text-red-600">*</span></label><input id="ke-name" maxlength="120" value="' + esc(ed.kit.name) + '" class="w-full px-3 py-2 border rounded-lg text-sm"></div>' +
            '<div class="md:col-span-2"><label for="ke-desc" class="block text-xs font-semibold text-gray-600 mb-1">Description (optional)</label><input id="ke-desc" maxlength="500" value="' + esc(ed.kit.description || '') + '" class="w-full px-3 py-2 border rounded-lg text-sm"></div></div>' +
            '<div id="ke-lines" class="overflow-x-auto"></div>' +
            '<div class="mt-5"><label for="ke-search" class="block text-xs font-semibold text-gray-600 mb-1">Add a part (part number or name)</label>' +
            '<input id="ke-search" type="search" autocomplete="off" value="' + esc(ed.q) + '" class="w-full md:w-96 px-3 py-2 border rounded-lg text-sm" placeholder="e.g. 05915 or body filler"><div id="ke-results" class="mt-2"></div></div>' +
            '<div class="mt-5 flex items-center gap-3"><button type="button" id="ke-save" class="bg-blue-700 hover:bg-blue-800 text-white font-semibold px-5 py-2.5 rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed">' +
            (ed.busy ? '<i class="fas fa-spinner fa-spin mr-1"></i>Saving&hellip;' : '<i class="fas fa-save mr-1"></i>Save changes') + '</button>' +
            '<button type="button" id="ke-cancel" class="text-sm text-gray-600 hover:underline">Cancel</button></div></div>';
        updateEdLines(); updateEdResults(); wireEditor();
    }

    function updateEdLines() {
        var host = $('ke-lines'), save = $('ke-save'); if (!host) return;
        if (save) save.disabled = ed.busy || !ed.lines.length;
        if (!ed.lines.length) { host.innerHTML = '<p class="text-sm text-gray-500">No parts. Add at least one below, or go back and remove the kit.</p>'; return; }
        var total = 0, unpriced = 0;
        var body = ed.lines.map(function (l, i) {
            var pr = linePrice(l), q = Number(l.quantity);
            var ext = pr != null && q > 0 ? pr * q : 0; total += ext; if (pr == null) unpriced++;
            var overridden = l.touched ? String(l.priceText || '').trim() !== '' : l.price_overridden;
            return '<tr class="border-b align-top"><td class="py-2 pr-2 font-mono text-xs">' + esc(l.sku) + '</td>' +
                '<td class="py-2 pr-2">' + (l.problem ? '<span class="text-amber-700 text-xs">' + esc(l.problem) + '</span>' : esc(l.name || '') + (l.brand ? ' <span class="text-xs text-gray-500">' + esc(l.brand) + '</span>' : '')) + '</td>' +
                '<td class="py-2 pr-2 text-right"><input type="number" step="any" min="0" value="' + esc(qty(l.quantity)) + '" data-ke-qty="' + i + '" aria-label="Quantity for ' + esc(l.sku) + '" class="w-20 px-2 py-1 border rounded text-right"> <span class="text-xs text-gray-400">' + esc(l.unit || 'each') + '</span></td>' +
                '<td class="py-2 pr-2 text-right"><div class="inline-flex items-center"><span class="text-gray-400 mr-1">$</span><input type="number" step="0.01" min="0" value="' + esc(l.priceText) + '" data-ke-price="' + i + '" placeholder="' + (l.catalogue_price != null ? esc(Number(l.catalogue_price).toFixed(2)) : 'set price') + '" aria-label="Unit price for ' + esc(l.sku) + '" class="w-24 px-2 py-1 border rounded text-right ' + (overridden ? 'border-blue-400 bg-blue-50' : '') + '"></div>' +
                (overridden ? '<div><button type="button" class="text-xs text-blue-700 hover:underline" data-ke-reset="' + i + '">Use standard price' + (l.catalogue_price != null ? ' ($' + Number(l.catalogue_price).toFixed(2) + ')' : '') + '</button></div>' : '') + '</td>' +
                '<td class="py-2 pr-2 text-right font-semibold" data-ke-ext="' + i + '">' + (pr == null ? '&mdash;' : money(ext)) + '</td>' +
                '<td class="py-2 text-right"><button type="button" class="text-red-600 hover:underline" data-ke-del="' + i + '" aria-label="Remove ' + esc(l.sku) + '">Remove</button></td></tr>';
        }).join('');
        host.innerHTML = '<table class="w-full text-sm"><thead><tr class="text-left text-xs uppercase text-gray-500 border-b"><th class="py-2 pr-2">Part number</th><th class="py-2 pr-2">Description</th><th class="py-2 pr-2 text-right">Quantity</th><th class="py-2 pr-2 text-right">Unit price</th><th class="py-2 pr-2 text-right">Line total</th><th class="py-2"></th></tr></thead><tbody>' + body +
            '</tbody><tfoot><tr><td colspan="4" class="py-3 text-right font-bold">Kit total (one use, before tax)</td><td class="py-3 pr-2 text-right font-bold" id="ke-total">' + money(total) + '</td><td></td></tr></tfoot></table>' +
            (unpriced ? '<p class="text-xs text-amber-700 mt-1">' + unpriced + ' part' + (unpriced === 1 ? ' has' : 's have') + ' no price yet. Enter one, or the kit cannot be submitted.</p>' : '');
        host.querySelectorAll('[data-ke-qty]').forEach(function (el) { el.addEventListener('input', function () { ed.lines[Number(el.getAttribute('data-ke-qty'))].quantity = Number(el.value); refreshEdTotals(); }); });
        host.querySelectorAll('[data-ke-price]').forEach(function (el) { el.addEventListener('input', function () { var l = ed.lines[Number(el.getAttribute('data-ke-price'))]; l.touched = true; l.priceText = el.value; refreshEdTotals(); }); el.addEventListener('change', updateEdLines); });
        host.querySelectorAll('[data-ke-reset]').forEach(function (b) { b.addEventListener('click', function () { var l = ed.lines[Number(b.getAttribute('data-ke-reset'))]; l.touched = true; l.priceText = ''; updateEdLines(); }); });
        host.querySelectorAll('[data-ke-del]').forEach(function (b) { b.addEventListener('click', function () { ed.lines.splice(Number(b.getAttribute('data-ke-del')), 1); updateEdLines(); updateEdResults(); }); });
    }

    function refreshEdTotals() {
        var total = 0;
        ed.lines.forEach(function (l, i) {
            var pr = linePrice(l), q = Number(l.quantity), ext = pr != null && q > 0 ? pr * q : 0; total += ext;
            var c = document.querySelector('[data-ke-ext="' + i + '"]'); if (c) c.innerHTML = pr == null ? '&mdash;' : money(ext);
        });
        var t = $('ke-total'); if (t) t.textContent = money(total);
    }

    function updateEdResults() {
        var host = $('ke-results'); if (!host) return;
        if (ed.searching) { host.innerHTML = '<p class="text-sm text-gray-500"><i class="fas fa-spinner fa-spin mr-1"></i>Searching&hellip;</p>'; return; }
        if (ed.q.length < 2) { host.innerHTML = ''; return; }
        if (!ed.results.length) { host.innerHTML = '<p class="text-sm text-gray-500">Nothing matches. Check the part number, or ask CHC to add the part.</p>'; return; }
        host.innerHTML = '<ul class="border rounded-lg divide-y max-h-64 overflow-y-auto">' + ed.results.map(function (p, i) {
            var have = ed.lines.some(function (l) { return skuKey(l.sku) === skuKey(p.sku); });
            return '<li><button type="button" data-ke-add="' + i + '" class="w-full text-left px-3 py-2 hover:bg-blue-50 flex items-center justify-between gap-3 disabled:opacity-50"' + (have ? ' disabled' : '') + '>' +
                '<span><span class="font-mono text-xs font-semibold">' + esc(p.sku) + '</span> <span class="text-sm">' + esc(p.name) + '</span>' + (p.brand ? ' <span class="text-xs text-gray-500">' + esc(p.brand) + '</span>' : '') + '</span>' +
                '<span class="text-xs ' + (have ? 'text-gray-400' : 'text-blue-700 font-semibold') + '">' + (have ? 'In kit' : '+ Add') + '</span></button></li>';
        }).join('') + '</ul>';
        host.querySelectorAll('[data-ke-add]').forEach(function (b) {
            b.addEventListener('click', function () {
                var p = ed.results[Number(b.getAttribute('data-ke-add'))];
                if (!p || ed.lines.some(function (l) { return skuKey(l.sku) === skuKey(p.sku); })) return;
                ed.lines.push({ kit_item_id: null, sku: p.sku, name: p.name, brand: p.brand, unit: p.unit || 'each', quantity: 1, unit_price: null, catalogue_price: null, price_overridden: false, problem: null, touched: false, priceText: '', isNew: true });
                updateEdLines(); updateEdResults();
            });
        });
    }

    function saveEditor() {
        if (ed.busy) return;
        var name = ($('ke-name').value || '').trim();
        if (!name) { $('ke-name').focus(); return edFail('Give the kit a name.'); }
        if (!ed.lines.length) return edFail('A kit needs at least one part.');
        for (var i = 0; i < ed.lines.length; i++) {
            if (!(Number(ed.lines[i].quantity) > 0)) return edFail('Set a quantity above zero for ' + ed.lines[i].sku + '.');
            var t = String(ed.lines[i].priceText || '').trim();
            if (ed.lines[i].touched && t !== '' && !(Number(t) >= 0)) return edFail('The price for ' + ed.lines[i].sku + ' must be a number, zero or more.');
        }
        var lines = ed.lines.map(function (l) {
            var o = { sku: l.sku, quantity: Number(l.quantity), unit: l.unit };
            if (l.kit_item_id) o.kit_item_id = l.kit_item_id;
            if (l.touched) { var t = String(l.priceText || '').trim(); o.unit_price = t === '' ? null : Number(t); }
            return o;
        });
        ed.busy = true; ed.banner = null; renderEditor();
        api('/my-kits/' + ed.kit.id, { method: 'PUT', body: { name: name, description: ($('ke-desc') && $('ke-desc').value) || '', lines: lines } })
            .then(jsonOf)
            .then(function (x) {
                if (!x.ok) throw new Error(x.d.error || 'Could not save that kit.');
                ed.busy = false;
                return loadKits().then(function () { ed.banner = { kind: 'ok', text: '"' + name + '" saved.' }; return openEditor(ed.kit.id, true); });
            })
            .catch(function (e) { edFail(e.message); });
    }

    function wireEditor() {
        var back = $('ke-back'); if (back) back.addEventListener('click', function () { showEdit(); });
        var cancel = $('ke-cancel'); if (cancel) cancel.addEventListener('click', function () { showEdit(); });
        var save = $('ke-save'); if (save) save.addEventListener('click', saveEditor);
        var search = $('ke-search'), timer = null;
        if (search) search.addEventListener('input', function () {
            ed.q = search.value.trim(); clearTimeout(timer);
            if (ed.q.length < 2) { ed.results = []; ed.searching = false; updateEdResults(); return; }
            ed.searching = true; updateEdResults();
            timer = setTimeout(function () {
                var asked = ed.q;
                api('/parts?q=' + encodeURIComponent(asked)).then(jsonOf).then(function (x) {
                    if (asked !== ed.q) return;
                    ed.searching = false; ed.results = x.ok ? (x.d.parts || []) : []; updateEdResults();
                }).catch(function () { ed.searching = false; ed.results = []; updateEdResults(); });
            }, 300);
        });
    }

    // ------------------------------------------------------------
    // Public surface
    // ------------------------------------------------------------
    window.KITSUB = {
        init: function (c) { ctx = c; return !!(c && c.mount); },
        showEdit: showEdit,
        showAdd: function () {
            if (!ctx || !ctx.addMount) return;
            ad.banner = null;
            renderAdd();
            loadMine().then(function () { ad.allowed = true; renderAdd(); })
                .catch(function (e) { adFail(e.message); });
        },
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
