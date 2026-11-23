/**
 * public/ordering-rules.js -- ordering rules and manager approvals (migration 071).
 *
 * Two parts, one file:
 *
 *   OrderingRulesPanel.mount(el, { req, title })
 *       The rules screen: the four rules for the company and each shop, the
 *       named approval passcodes, and the items that need a manager. Mounted by
 *       the CHC console (admin/index.html) and by the store's own "Ordering
 *       rules" screen. `req(path, options)` reaches .../ordering-rules + path
 *       ('' or '/manage' for the first read, then /company, /locations/:id, ...).
 *
 *   ORules (store only)
 *       What staff and managers see while ordering: the hold notice and limits
 *       in the cart, a lock on items that need a manager, the "a manager needs
 *       to approve this" step at checkout with the order and its total, and
 *       the orders waiting for approval on the Orders screen.
 *
 * The server decides every rule (utils/ordering-rules.js). Nothing here can let
 * an order through; it only shows what the server said and asks for what it
 * needs. Plain DOM, every dynamic string escaped, Tailwind classes both pages load.
 */
(function () {
    'use strict';

    // ------------------------------------------------------------------
    // Shared helpers
    // ------------------------------------------------------------------
    function esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function money(n) {
        var x = Math.round(Number(n || 0) * 100) / 100;
        return '$' + x.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function when(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) + ' ' +
            d.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
    }
    async function readJson(resp) {
        try { return await resp.json(); } catch (_) { return {}; }
    }
    function el(html) {
        var t = document.createElement('template');
        t.innerHTML = html.trim();
        return t.content.firstElementChild;
    }

    /** A modal on top of everything. Returns { box, close }. */
    function modal(innerHtml, opts) {
        opts = opts || {};
        var back = el('<div class="fixed inset-0 z-[70] bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4" role="dialog" aria-modal="true"></div>');
        var box = el('<div class="bg-white w-full sm:max-w-' + (opts.wide ? '3xl' : 'lg') +
            ' max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl shadow-xl p-4 sm:p-6"></div>');
        box.innerHTML = innerHtml;
        back.appendChild(box);
        document.body.appendChild(back);
        function close() { if (back.parentNode) back.parentNode.removeChild(back); document.removeEventListener('keydown', onKey); }
        function onKey(e) { if (e.key === 'Escape') close(); }
        document.addEventListener('keydown', onKey);
        back.addEventListener('click', function (e) { if (e.target === back && !opts.sticky) close(); });
        return { box: box, close: close };
    }

    /**
     * A passcode field with its own number keys, so it works on a phone with a
     * scanner plugged in (where the phone keyboard never appears) and on a
     * tablet, and still takes typing on a computer. Digits are hidden.
     */
    function passcodeField(id, label) {
        var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'];
        return '<label for="' + id + '" class="block text-sm font-semibold text-gray-700 mb-1">' + esc(label || 'Approval passcode') + '</label>' +
            '<input id="' + id + '" type="password" inputmode="numeric" autocomplete="off" maxlength="12" ' +
            'class="w-full border rounded-lg px-3 py-3 text-2xl tracking-[0.4em] text-center font-mono" data-orules-pass>' +
            '<div class="grid grid-cols-3 gap-2 mt-2" data-orules-keys="' + id + '">' +
            keys.map(function (k) {
                var lab = k === 'back' ? '<i class="fas fa-delete-left"></i><span class="sr-only">Delete</span>' : k === 'clear' ? 'Clear' : k;
                return '<button type="button" data-k="' + k + '" class="py-3 rounded-lg bg-gray-100 hover:bg-gray-200 text-lg font-semibold">' + lab + '</button>';
            }).join('') + '</div>';
    }
    function wireKeys(root) {
        root.querySelectorAll('[data-orules-keys]').forEach(function (pad) {
            var input = root.querySelector('#' + pad.getAttribute('data-orules-keys'));
            pad.addEventListener('click', function (e) {
                var b = e.target.closest('button[data-k]');
                if (!b || !input) return;
                var k = b.getAttribute('data-k');
                if (k === 'back') input.value = input.value.slice(0, -1);
                else if (k === 'clear') input.value = '';
                else if (input.value.length < 12) input.value += k;
            });
        });
        root.querySelectorAll('[data-orules-pass]').forEach(function (i) {
            i.addEventListener('input', function () { i.value = i.value.replace(/\D/g, '').slice(0, 12); });
        });
    }

    function reasonsHtml(reasons) {
        return '<ul class="space-y-2">' + (reasons || []).map(function (r) {
            return '<li class="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2">' +
                '<p class="font-semibold text-amber-900"><i class="fas fa-hand mr-1"></i>' + esc(r.title) + '</p>' +
                '<p class="text-sm text-amber-900">' + esc(r.detail) + '</p></li>';
        }).join('') + '</ul>';
    }

    function orderTableHtml(o, hidePrices) {
        if (!o) return '';
        var items = o.items || [];
        var rows = items.map(function (i) {
            return '<tr class="border-t"><td class="py-1.5 pr-2">' + esc(i.name) +
                (i.sku ? '<span class="block text-xs text-gray-400">' + esc(i.sku) + '</span>' : '') + '</td>' +
                '<td class="py-1.5 px-2 text-center">' + esc(i.quantity) + '</td>' +
                (hidePrices ? '' : '<td class="py-1.5 pl-2 text-right tabular-nums">' +
                    (i.price_on_request ? 'Priced by branch' : money(i.subtotal)) + '</td>') + '</tr>';
        }).join('');
        var fees = (o.fee_lines || []).map(function (f) {
            return '<div class="flex justify-between"><span>' + esc(f.label) + '</span><span class="tabular-nums">' + money(f.amount) + '</span></div>';
        }).join('');
        return '<div class="overflow-x-auto"><table class="w-full text-sm"><thead><tr class="text-left text-xs text-gray-500">' +
            '<th class="pb-1">Item</th><th class="pb-1 text-center">Qty</th>' + (hidePrices ? '' : '<th class="pb-1 text-right">Amount</th>') +
            '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
            (hidePrices ? '' : '<div class="mt-2 border-t pt-2 text-sm space-y-0.5">' +
                '<div class="flex justify-between"><span>Subtotal</span><span class="tabular-nums">' + money(o.subtotal) + '</span></div>' +
                (Number(o.tax) > 0 ? '<div class="flex justify-between"><span>Tax</span><span class="tabular-nums">' + money(o.tax) + '</span></div>' : '') +
                fees +
                '<div class="flex justify-between font-bold text-base"><span>Total</span><span class="tabular-nums">' + money(o.total) + '</span></div>' +
                (o.unpriced_items ? '<p class="text-xs text-gray-500">' + esc(o.unpriced_items) + ' item(s) are priced by the branch and are not in this total.</p>' : '') +
                '</div>');
    }

    // ------------------------------------------------------------------
    // THE RULES SCREEN (console and store)
    // ------------------------------------------------------------------
    var RULES = [
        { key: 'order_limit', label: 'Order limit', help: 'Orders over this amount, before tax, need a manager.', amount: 'order_limit' },
        { key: 'stock_ceiling', label: 'Stock limit', help: 'Stock on the shelf, plus orders on the way, plus this order may not go over this amount without a manager. Uses refinishAI Inventory stock values.', amount: 'stock_ceiling' },
        { key: 'hold', label: 'Orders on hold', help: 'Staff can still build orders. Nothing goes to CHC until a manager approves it.' },
        { key: 'staff_items', label: 'Items that need a manager', help: 'Items marked below (equipment, tools) need a manager. Everything else staff can order freely.' }
    ];

    function mountPanel(root, opts) {
        var req = opts.req;
        var loadPath = opts.loadPath || '';
        var data = null;
        var itemsState = { search: '', category: '', only: '', page: 1 };

        function flash(msg, bad) {
            var f = root.querySelector('[data-flash]');
            if (!f) return;
            f.className = 'text-sm rounded-lg px-3 py-2 mb-3 ' + (bad ? 'bg-red-50 text-red-800 border border-red-200' : 'bg-green-50 text-green-800 border border-green-200');
            f.textContent = msg;
            f.hidden = false;
            clearTimeout(flash._t);
            flash._t = setTimeout(function () { f.hidden = true; }, bad ? 8000 : 4000);
        }
        async function send(path, method, body) {
            var resp = await req(path, { method: method, body: body === undefined ? undefined : JSON.stringify(body) });
            var d = await readJson(resp);
            if (!resp.ok) { flash(d.error || 'That did not save.', true); return null; }
            flash(d.message || 'Saved.');
            return d;
        }

        async function load() {
            root.innerHTML = '<p class="text-gray-500 py-6 text-center"><i class="fas fa-spinner fa-spin mr-2"></i>Loading ordering rules…</p>';
            var resp = await req(loadPath);
            var d = await readJson(resp);
            if (!resp.ok) {
                root.innerHTML = '<p class="text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">' + esc(d.error || 'Could not load the ordering rules.') + '</p>';
                if (d.unlock_required && opts.onLocked) opts.onLocked();
                return;
            }
            data = d;
            render();
        }

        function companyRuleRow(r) {
            var row = data.company_rules || {};
            var on = row[r.key + '_on'] === true;
            return '<div class="py-3 border-t first:border-t-0" data-co-rule="' + r.key + '">' +
                '<label class="flex items-start gap-3 cursor-pointer">' +
                '<input type="checkbox" id="orc-' + r.key + '" class="mt-1 h-5 w-5 flex-none" ' + (on ? 'checked' : '') + '>' +
                '<span><span class="font-semibold text-gray-800">' + esc(r.label) + '</span>' +
                '<span class="block text-xs text-gray-500">' + esc(r.help) + '</span></span></label>' +
                (r.amount ? '<div class="mt-2 ml-8 flex items-center gap-2"><span class="text-gray-500">$</span>' +
                    '<input type="text" inputmode="decimal" id="orc-' + r.key + '-amt" class="border rounded-lg px-2 py-1.5 w-36 tabular-nums" placeholder="0.00" value="' +
                    esc(row[r.amount] == null ? '' : Number(row[r.amount]).toFixed(2)) + '"></div>' : '') +
                (r.key === 'hold' ? '<div class="mt-2 ml-8"><label class="text-xs text-gray-500" for="orc-hold-msg">Message staff see</label>' +
                    '<input type="text" id="orc-hold-msg" maxlength="300" class="w-full border rounded-lg px-2 py-1.5 text-sm" placeholder="' +
                    esc(data.default_hold_message || '') + '" value="' + esc(row.hold_message || '') + '"></div>' : '') +
                '</div>';
        }

        function effectiveLabel(e, r) {
            var x = e[r.key];
            if (!x || !x.on) return 'Off';
            return x.amount != null ? 'On · ' + money(x.amount) : 'On';
        }

        function shopRow(l) {
            var own = l.own || {};
            return '<div class="py-3 border-t first:border-t-0" data-shop="' + esc(l.id) + '">' +
                '<p class="font-semibold text-gray-800 mb-2">' + esc(l.name) + '</p>' +
                '<div class="grid sm:grid-cols-2 gap-2">' + RULES.map(function (r) {
                    var v = own[r.key + '_on'];
                    var sel = v === true ? 'on' : v === false ? 'off' : 'inherit';
                    return '<div class="rounded-lg bg-gray-50 p-2"><label class="text-xs font-semibold text-gray-600" for="ors-' + esc(l.id) + '-' + r.key + '">' + esc(r.label) +
                        ' <span class="font-normal text-gray-400">(now: ' + esc(effectiveLabel(l.effective, r)) + ')</span></label>' +
                        '<div class="flex gap-2 mt-1"><select id="ors-' + esc(l.id) + '-' + r.key + '" data-k="' + r.key + '" class="border rounded-lg px-2 py-1.5 text-sm flex-1 min-w-0">' +
                        '<option value="inherit"' + (sel === 'inherit' ? ' selected' : '') + '>Same as company</option>' +
                        '<option value="on"' + (sel === 'on' ? ' selected' : '') + '>On for this shop</option>' +
                        '<option value="off"' + (sel === 'off' ? ' selected' : '') + '>Off for this shop</option></select>' +
                        (r.amount ? '<input type="text" inputmode="decimal" data-amt="' + r.key + '" aria-label="' + esc(r.label) + ' amount for ' + esc(l.name) + '" class="border rounded-lg px-2 py-1.5 text-sm w-28 tabular-nums" placeholder="Company $" value="' +
                            esc(own[r.amount] == null ? '' : Number(own[r.amount]).toFixed(2)) + '">' : '') +
                        '</div></div>';
                }).join('') + '</div>' +
                '<div class="mt-2 flex justify-end"><button type="button" data-save-shop="' + esc(l.id) + '" class="bg-blue-700 hover:bg-blue-800 text-white text-sm px-4 py-2 rounded-lg">Save ' + esc(l.name) + '</button></div>' +
                '</div>';
        }

        function passcodesHtml() {
            var shops = data.locations || [];
            var shopName = function (id) { var s = shops.find(function (x) { return x.id === id; }); return s ? s.name : 'one shop'; };
            var list = (data.passcodes || []).map(function (p) {
                return '<div class="py-2 border-t first:border-t-0 flex flex-wrap items-center gap-2" data-pc="' + esc(p.id) + '">' +
                    '<div class="flex-1 min-w-[10rem]"><p class="font-semibold ' + (p.is_active ? 'text-gray-800' : 'text-gray-400 line-through') + '">' + esc(p.name) + '</p>' +
                    '<p class="text-xs text-gray-500">' + (p.location_id ? esc(shopName(p.location_id)) + ' only' : 'Every shop') +
                    ' · ' + (p.last_used_at ? 'last used ' + esc(when(p.last_used_at)) + ' (' + esc(p.use_count || 0) + ' times)' : 'not used yet') + '</p></div>' +
                    '<button type="button" data-pc-code="' + esc(p.id) + '" class="text-sm text-blue-700 hover:underline">New code</button>' +
                    '<button type="button" data-pc-toggle="' + esc(p.id) + '" data-on="' + (p.is_active ? '1' : '0') + '" class="text-sm ' + (p.is_active ? 'text-red-700' : 'text-green-700') + ' hover:underline">' +
                    (p.is_active ? 'Switch off' : 'Switch on') + '</button></div>';
            }).join('') || '<p class="text-sm text-gray-500 py-2">No approval passcodes yet. Add one for each manager.</p>';
            return '<div>' + list + '</div>' +
                '<div class="mt-3 rounded-lg bg-gray-50 p-3 grid sm:grid-cols-4 gap-2 items-end">' +
                '<div class="sm:col-span-1"><label class="text-xs font-semibold text-gray-600" for="orp-name">Name</label>' +
                '<input id="orp-name" type="text" maxlength="60" class="w-full border rounded-lg px-2 py-1.5 text-sm" placeholder="e.g. Mike"></div>' +
                '<div><label class="text-xs font-semibold text-gray-600" for="orp-shop">Works at</label>' +
                '<select id="orp-shop" class="w-full border rounded-lg px-2 py-1.5 text-sm"><option value="">Every shop</option>' +
                shops.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.name) + ' only</option>'; }).join('') + '</select></div>' +
                '<div><label class="text-xs font-semibold text-gray-600" for="orp-code">Passcode (6–12 digits)</label>' +
                '<input id="orp-code" type="password" inputmode="numeric" autocomplete="new-password" maxlength="12" class="w-full border rounded-lg px-2 py-1.5 text-sm font-mono" data-orules-pass></div>' +
                '<button type="button" data-pc-add class="bg-blue-700 hover:bg-blue-800 text-white text-sm px-4 py-2 rounded-lg">Add passcode</button></div>' +
                '<p class="text-xs text-gray-500 mt-2">Each passcode is shown only while you type it. Every approval records which passcode gave it. ' +
                'The shop decides who holds which passcode; switch one off the day someone leaves.</p>';
        }

        function itemsHtml() {
            return '<div data-items-groups class="text-sm text-gray-500">Loading categories…</div>' +
                '<div class="mt-3 flex flex-wrap gap-2 items-center">' +
                '<input type="search" id="ori-search" class="border rounded-lg px-2 py-1.5 text-sm flex-1 min-w-[10rem]" placeholder="Search items by name or part number" value="' + esc(itemsState.search) + '">' +
                '<select id="ori-only" class="border rounded-lg px-2 py-1.5 text-sm"><option value="">All items</option>' +
                '<option value="locked"' + (itemsState.only === 'locked' ? ' selected' : '') + '>Need a manager</option>' +
                '<option value="open"' + (itemsState.only === 'open' ? ' selected' : '') + '>Staff can order</option></select></div>' +
                '<div data-items-list class="mt-2"></div>';
        }

        function render() {
            var m = data.manager || {};
            var companyWide = m.company_wide !== false;
            var waiting = data.waiting || [];
            root.innerHTML =
                '<div data-flash hidden></div>' +
                (m.name && opts.showManager ? '<p class="text-sm text-gray-500 mb-3">Signed in to the rules as <strong>' + esc(m.name) + '</strong>' +
                    (companyWide ? '' : ' (one shop only)') + '.</p>' : '') +
                (companyWide ? '<section class="mb-6"><h3 class="text-lg font-bold text-gray-800">Whole company</h3>' +
                    '<p class="text-sm text-gray-500 mb-2">Every rule is off until you turn it on. Each shop follows these unless it has its own setting below.</p>' +
                    '<div class="rounded-xl border p-3">' + RULES.map(companyRuleRow).join('') +
                    '<div class="mt-3 flex justify-end"><button type="button" data-save-company class="bg-blue-700 hover:bg-blue-800 text-white px-4 py-2 rounded-lg">Save company rules</button></div></div></section>' : '') +
                '<section class="mb-6"><h3 class="text-lg font-bold text-gray-800">' + (companyWide ? 'Each shop' : 'Your shop') + '</h3>' +
                '<p class="text-sm text-gray-500 mb-2">Leave a shop on "Same as company" unless it needs its own amount or switch. A blank amount uses the company amount.</p>' +
                '<div class="rounded-xl border p-3">' + ((data.locations || []).map(shopRow).join('') || '<p class="text-sm text-gray-500">No shops yet.</p>') + '</div></section>' +
                (companyWide ? '<section class="mb-6"><h3 class="text-lg font-bold text-gray-800">Approval passcodes</h3>' +
                    '<p class="text-sm text-gray-500 mb-2">A manager types one of these to approve an order, release one that is waiting, or change these rules.</p>' +
                    '<div class="rounded-xl border p-3">' + passcodesHtml() + '</div></section>' +
                    '<section class="mb-6"><h3 class="text-lg font-bold text-gray-800">Items that need a manager</h3>' +
                    '<p class="text-sm text-gray-500 mb-2">Used when "Items that need a manager" is on. Staff still see these items with a lock, and can ask for them.</p>' +
                    '<div class="rounded-xl border p-3">' + itemsHtml() + '</div></section>' : '') +
                (waiting.length ? '<section><h3 class="text-lg font-bold text-gray-800">Waiting for a manager now</h3><div class="rounded-xl border p-3 text-sm">' +
                    waiting.map(function (a) {
                        var shop = (data.locations || []).find(function (l) { return l.id === a.location_id; });
                        return '<div class="py-1.5 border-t first:border-t-0 flex flex-wrap justify-between gap-2"><span>' + esc(shop ? shop.name : '') + ' · ' + esc(a.contact_name || '') +
                            ' · ' + esc(when(a.created_at)) + '</span><span class="tabular-nums font-semibold">' + money(a.total) + '</span></div>';
                    }).join('') + '<p class="text-xs text-gray-500 mt-2">The shop’s managers release or decline these from the store’s Orders screen.</p></div></section>' : '');
            wire();
            if (companyWide) { loadGroups(); loadItems(); }
        }

        function wire() {
            wireKeys(root);
            var saveCo = root.querySelector('[data-save-company]');
            if (saveCo) saveCo.addEventListener('click', async function () {
                var body = {};
                RULES.forEach(function (r) {
                    body[r.key + '_on'] = root.querySelector('#orc-' + r.key).checked;
                    if (r.amount) body[r.amount] = root.querySelector('#orc-' + r.key + '-amt').value;
                });
                body.hold_message = root.querySelector('#orc-hold-msg').value;
                saveCo.disabled = true;
                var d = await send('/company', 'PUT', body);
                saveCo.disabled = false;
                if (d) await load();
            });
            root.querySelectorAll('[data-save-shop]').forEach(function (b) {
                b.addEventListener('click', async function () {
                    var id = b.getAttribute('data-save-shop');
                    var box = root.querySelector('[data-shop="' + id + '"]');
                    var body = {};
                    box.querySelectorAll('select[data-k]').forEach(function (s) {
                        var k = s.getAttribute('data-k');
                        body[k + '_on'] = s.value === 'inherit' ? null : s.value === 'on';
                    });
                    box.querySelectorAll('input[data-amt]').forEach(function (i) { body[i.getAttribute('data-amt')] = i.value === '' ? null : i.value; });
                    b.disabled = true;
                    var d = await send('/locations/' + encodeURIComponent(id), 'PUT', body);
                    b.disabled = false;
                    if (d) await load();
                });
            });
            var add = root.querySelector('[data-pc-add]');
            if (add) add.addEventListener('click', async function () {
                var body = {
                    name: root.querySelector('#orp-name').value,
                    location_id: root.querySelector('#orp-shop').value || null,
                    passcode: root.querySelector('#orp-code').value
                };
                add.disabled = true;
                var d = await send('/passcodes', 'POST', body);
                add.disabled = false;
                if (d) await load();
            });
            root.querySelectorAll('[data-pc-toggle]').forEach(function (b) {
                b.addEventListener('click', async function () {
                    var on = b.getAttribute('data-on') === '1';
                    var d = await send('/passcodes/' + encodeURIComponent(b.getAttribute('data-pc-toggle')), 'PUT', { is_active: !on });
                    if (d) await load();
                });
            });
            root.querySelectorAll('[data-pc-code]').forEach(function (b) {
                b.addEventListener('click', function () {
                    var id = b.getAttribute('data-pc-code');
                    var m = modal('<h3 class="text-lg font-bold mb-2">New code</h3><p class="text-sm text-gray-500 mb-3">The old code stops working as soon as you save.</p>' +
                        passcodeField('orp-new', 'New passcode (6–12 digits)') +
                        '<div class="mt-4 flex gap-2 justify-end"><button type="button" data-x class="px-4 py-2 rounded-lg bg-gray-100">Cancel</button>' +
                        '<button type="button" data-ok class="px-4 py-2 rounded-lg bg-blue-700 text-white">Save code</button></div>');
                    wireKeys(m.box);
                    m.box.querySelector('[data-x]').addEventListener('click', m.close);
                    m.box.querySelector('[data-ok]').addEventListener('click', async function () {
                        var d = await send('/passcodes/' + encodeURIComponent(id), 'PUT', { passcode: m.box.querySelector('#orp-new').value });
                        if (d) { m.close(); await load(); }
                    });
                });
            });
            var search = root.querySelector('#ori-search');
            if (search) {
                var t = null;
                search.addEventListener('input', function () {
                    clearTimeout(t);
                    t = setTimeout(function () { itemsState.search = search.value; itemsState.page = 1; loadItems(); }, 300);
                });
                root.querySelector('#ori-only').addEventListener('change', function (e) { itemsState.only = e.target.value; itemsState.page = 1; loadItems(); });
            }
        }

        async function loadGroups() {
            var host = root.querySelector('[data-items-groups]');
            if (!host) return;
            var resp = await req('/items/groups');
            var g = await readJson(resp);
            if (!resp.ok) { host.textContent = g.error || 'Could not load the categories.'; return; }
            host.innerHTML = '<p class="mb-2"><strong class="text-gray-800">' + esc(g.locked) + '</strong> of ' + esc(g.total) + ' items need a manager. Lock a whole category at once:</p>' +
                '<div class="grid sm:grid-cols-2 gap-1">' + (g.categories || []).map(function (c) {
                    var all = c.locked === c.total && c.total > 0;
                    return '<div class="flex items-center justify-between gap-2 rounded-lg ' + (c.locked ? 'bg-amber-50' : 'bg-gray-50') + ' px-2 py-1.5">' +
                        '<button type="button" data-cat-show="' + esc(c.name) + '" class="text-left text-gray-800 hover:underline min-w-0 truncate">' + esc(c.name) + '</button>' +
                        '<span class="text-xs text-gray-500 whitespace-nowrap">' + esc(c.locked) + '/' + esc(c.total) + '</span>' +
                        '<button type="button" data-cat="' + esc(c.name) + '" data-to="' + (all ? '0' : '1') + '" class="text-xs whitespace-nowrap ' + (all ? 'text-green-700' : 'text-amber-800') + ' hover:underline">' +
                        (all ? 'Let staff order' : 'All need a manager') + '</button></div>';
                }).join('') + '</div>';
            host.querySelectorAll('[data-cat]').forEach(function (b) {
                b.addEventListener('click', async function () {
                    var d = await send('/items', 'POST', { category: b.getAttribute('data-cat'), requires_approval: b.getAttribute('data-to') === '1' });
                    if (d) { loadGroups(); loadItems(); }
                });
            });
            host.querySelectorAll('[data-cat-show]').forEach(function (b) {
                b.addEventListener('click', function () { itemsState.category = b.getAttribute('data-cat-show'); itemsState.page = 1; loadItems(); });
            });
        }

        async function loadItems() {
            var host = root.querySelector('[data-items-list]');
            if (!host) return;
            var q = new URLSearchParams({ page: String(itemsState.page), limit: '25' });
            if (itemsState.search) q.set('search', itemsState.search);
            if (itemsState.only) q.set('only', itemsState.only);
            if (itemsState.category && itemsState.category !== '(none)') q.set('category', itemsState.category);
            var resp = await req('/items?' + q.toString());
            var d = await readJson(resp);
            if (!resp.ok) { host.textContent = d.error || 'Could not load the items.'; return; }
            var pages = Math.max(1, Math.ceil((d.total || 0) / (d.limit || 25)));
            host.innerHTML = (itemsState.category ? '<p class="text-xs text-gray-500 mb-1">Showing ' + esc(itemsState.category) +
                    ' · <button type="button" data-cat-clear class="text-blue-700 hover:underline">all categories</button></p>' : '') +
                ((d.items || []).map(function (i) {
                    return '<label class="flex items-center gap-3 py-1.5 border-t first:border-t-0 cursor-pointer">' +
                        '<input type="checkbox" data-item="' + esc(i.id) + '" class="h-5 w-5" ' + (i.requires_approval ? 'checked' : '') + '>' +
                        '<span class="flex-1 min-w-0"><span class="block text-sm text-gray-800 truncate">' + esc(i.name) + '</span>' +
                        '<span class="block text-xs text-gray-500">' + esc(i.sku || '') + ' · ' + esc(i.category || '') + '</span></span>' +
                        '<span class="text-xs ' + (i.requires_approval ? 'text-amber-800' : 'text-gray-400') + ' whitespace-nowrap">' +
                        (i.requires_approval ? '<i class="fas fa-lock mr-1"></i>Manager' : 'Staff OK') + '</span></label>';
                }).join('') || '<p class="text-sm text-gray-500 py-2">No items match.</p>') +
                (pages > 1 ? '<div class="flex items-center justify-between mt-2 text-sm"><button type="button" data-pg="-1" class="text-blue-700 disabled:text-gray-300" ' + (itemsState.page <= 1 ? 'disabled' : '') + '>Previous</button>' +
                    '<span class="text-gray-500">Page ' + esc(itemsState.page) + ' of ' + esc(pages) + '</span>' +
                    '<button type="button" data-pg="1" class="text-blue-700 disabled:text-gray-300" ' + (itemsState.page >= pages ? 'disabled' : '') + '>Next</button></div>' : '');
            host.querySelectorAll('[data-item]').forEach(function (c) {
                c.addEventListener('change', async function () {
                    var d2 = await send('/items', 'POST', { product_ids: [c.getAttribute('data-item')], requires_approval: c.checked });
                    if (!d2) c.checked = !c.checked; else { loadGroups(); loadItems(); }
                });
            });
            host.querySelectorAll('[data-pg]').forEach(function (b) {
                b.addEventListener('click', function () { itemsState.page += Number(b.getAttribute('data-pg')); loadItems(); });
            });
            var clr = host.querySelector('[data-cat-clear]');
            if (clr) clr.addEventListener('click', function () { itemsState.category = ''; itemsState.page = 1; loadItems(); });
        }

        load();
        return { reload: load };
    }

    window.OrderingRulesPanel = { mount: mountPanel };

    // ------------------------------------------------------------------
    // THE STORE
    // ------------------------------------------------------------------
    // Uses the store page's own top-level names (state, apiFetch, showTab,
    // loadCart, renderCart, updateCartBadge). Does nothing on a page without them.
    function inStore() {
        return typeof apiFetch === 'function' && typeof state === 'object' && state && state.slug;   // eslint-disable-line no-undef
    }
    function store() { return state; }   // eslint-disable-line no-undef
    function api(path, options) { return apiFetch('/store/' + encodeURIComponent(store().slug) + '/ordering-rules' + path, options); }   // eslint-disable-line no-undef
    function locId() { var s = store(); return s.location && s.location.id; }
    function hidePrices() { var c = store().company; return !!(c && c.settings && c.settings.hide_pricing && c.settings.hide_pricing.enabled); }

    var ORules = { status: null, rulesToken: null, rulesTokenAt: 0 };

    ORules.load = async function () {
        if (!inStore() || !locId()) return;
        try {
            var resp = await api('/status?location_id=' + encodeURIComponent(locId()));
            ORules.status = resp.ok ? await readJson(resp) : null;
        } catch (_) { ORules.status = null; }
        ORules.paint();
    };

    ORules.staffItemsOn = function () {
        var s = ORules.status;
        return !!(s && s.rules && s.rules.staff_items && s.rules.staff_items.on);
    };

    /** The lock shown on a product card. */
    ORules.badge = function (p) {
        if (!p || !p.requires_approval || !ORules.staffItemsOn()) return '';
        return '<p class="text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-2" data-needs-manager>' +
            '<i class="fas fa-lock mr-1"></i>Needs manager approval</p>';
    };

    /** The notices in the cart and the waiting count on the Orders screen. */
    ORules.paint = function () {
        var s = ORules.status;
        var host = document.getElementById('orules-cart-note');
        if (host) {
            var lines = [];
            if (s && s.rules) {
                if (s.rules.hold.on) lines.push('<p class="font-semibold"><i class="fas fa-circle-pause mr-1"></i>Orders are on hold</p><p>' + esc(s.rules.hold.message) + '</p>');
                if (s.rules.order_limit.on) lines.push('<p>Orders over <strong>' + money(s.rules.order_limit.amount) + '</strong> before tax need a manager’s approval.</p>');
                if (s.rules.stock_ceiling.on) lines.push('<p>This shop keeps stock at or under <strong>' + money(s.rules.stock_ceiling.amount) + '</strong>. Orders that would go over it need a manager.</p>');
                if (s.rules.staff_items.on) lines.push('<p>Items marked <i class="fas fa-lock"></i> need a manager’s approval.</p>');
            }
            host.innerHTML = lines.length ? '<div class="rounded-lg border ' + (s.rules.hold.on ? 'border-amber-400 bg-amber-50 text-amber-900' : 'border-blue-200 bg-blue-50 text-blue-900') +
                ' px-3 py-2 text-sm space-y-1 mb-4">' + lines.join('') + '</div>' : '';
        }
        var chip = document.getElementById('orules-orders-chip');
        if (chip) {
            var n = s ? Number(s.waiting || 0) : 0;
            chip.textContent = n ? n + ' waiting for approval' : '';
            chip.hidden = !n;
        }
        var btn = document.getElementById('orules-open-btn');
        if (btn) btn.hidden = !(s && (s.any_on || s.has_passcodes || s.is_owner));
    };

    /**
     * Checkout hit a rule. Show the order, its total and why; take a passcode
     * now, or send it for approval. `resend(extra)` posts the same order again
     * with extra fields and resolves with { resp, data }.
     */
    ORules.decide = function (first, resend, done) {
        var m = modal(
            '<h3 class="text-xl font-bold text-gray-800 mb-1"><i class="fas fa-user-shield mr-2 text-amber-600"></i>A manager needs to approve this order</h3>' +
            '<p class="text-sm text-gray-500 mb-3">' + esc(first.order && first.order.location ? first.order.location.name : '') + '</p>' +
            reasonsHtml(first.reasons) +
            '<div class="mt-4 rounded-xl border p-3">' + orderTableHtml(first.order, hidePrices()) + '</div>' +
            '<div class="mt-4">' + (first.has_passcodes === false
                ? '<p class="text-sm rounded-lg bg-gray-50 border p-3">No approval passcode is set up for this shop yet. Send it for approval, and ask CHC to add a passcode for your manager.</p>'
                : passcodeField('orules-pass', 'Manager: enter your approval passcode')) + '</div>' +
            '<p data-err class="hidden mt-2 text-sm text-red-700"></p>' +
            '<div class="mt-4 grid gap-2">' +
            (first.has_passcodes === false ? '' : '<button type="button" data-approve class="w-full bg-green-700 hover:bg-green-800 text-white font-semibold py-3 rounded-lg"><i class="fas fa-check mr-2"></i>Approve and send to CHC</button>') +
            (first.can_hold === false ? '' : '<button type="button" data-hold class="w-full bg-amber-500 hover:bg-amber-600 text-white font-semibold py-3 rounded-lg"><i class="fas fa-clock mr-2"></i>Send for manager approval</button>') +
            '<button type="button" data-back class="w-full bg-gray-100 hover:bg-gray-200 py-3 rounded-lg">Back to cart</button></div>',
            { sticky: true });
        wireKeys(m.box);
        var err = m.box.querySelector('[data-err]');
        function showErr(msg) { err.textContent = msg; err.classList.remove('hidden'); }
        function busy(on) { m.box.querySelectorAll('button').forEach(function (b) { b.disabled = on; }); }
        m.box.querySelector('[data-back]').addEventListener('click', function () { m.close(); done(null); });
        var ap = m.box.querySelector('[data-approve]');
        if (ap) ap.addEventListener('click', async function () {
            var code = m.box.querySelector('#orules-pass').value;
            if (!code) { showErr('Enter the approval passcode.'); return; }
            busy(true);
            var r = await resend({ approval_passcode: code });
            busy(false);
            if (r.resp.ok) { m.close(); done(r); return; }
            m.box.querySelector('#orules-pass').value = '';
            showErr((r.data && r.data.error) || 'That did not go through.' +
                (r.data && r.data.attempts_left ? '' : ''));
            if (r.data && r.data.attempts_left) showErr(r.data.error + ' ' + r.data.attempts_left + ' tries left.');
        });
        var hold = m.box.querySelector('[data-hold]');
        if (hold) hold.addEventListener('click', async function () {
            busy(true);
            var r = await resend({ hold_for_approval: true });
            busy(false);
            if (r.resp.ok) { m.close(); done(r); return; }
            showErr((r.data && r.data.error) || 'Could not send it for approval.');
        });
    };

    /**
     * A passcode for an order that cannot wait (a refinishAI Inventory reorder
     * is already a queue). Shows the order and why; resolves with the code, or
     * null if cancelled. A wrong code comes back here with the server's message.
     */
    ORules.askPasscode = function (first) {
        return new Promise(function (resolve) {
            var m = modal(
                '<h3 class="text-xl font-bold text-gray-800 mb-2"><i class="fas fa-user-shield mr-2 text-amber-600"></i>A manager needs to approve this order</h3>' +
                (first.passcode_rejected ? '<p class="text-sm text-red-700 mb-2">' + esc(first.error) + (first.attempts_left ? ' ' + esc(first.attempts_left) + ' tries left.' : '') + '</p>' : '') +
                reasonsHtml(first.reasons) +
                '<div class="mt-4 rounded-xl border p-3">' + orderTableHtml(Object.assign({ total: first.order && first.order.subtotal }, first.order || {}), hidePrices()) + '</div>' +
                '<div class="mt-4">' + passcodeField('orules-ask', 'Manager: enter your approval passcode') + '</div>' +
                '<div class="mt-4 grid grid-cols-2 gap-2"><button type="button" data-x class="py-3 rounded-lg bg-gray-100">Cancel</button>' +
                '<button type="button" data-ok class="py-3 rounded-lg bg-green-700 text-white font-semibold">Approve and send</button></div>', { sticky: true });
            wireKeys(m.box);
            m.box.querySelector('[data-x]').addEventListener('click', function () { m.close(); resolve(null); });
            m.box.querySelector('[data-ok]').addEventListener('click', function () {
                var v = m.box.querySelector('#orules-ask').value;
                if (!v) return;
                m.close(); resolve(v);
            });
        });
    };

    /** Confirmation after an order was saved for a manager. */
    ORules.heldNotice = function (data) {
        var a = data.approval || {};
        var m = modal('<div class="text-center"><i class="fas fa-clock text-4xl text-amber-500 mb-3"></i>' +
            '<h3 class="text-xl font-bold text-gray-800 mb-2">Sent for manager approval</h3>' +
            '<p class="text-gray-600 mb-1">Approval <strong class="font-mono">' + esc(a.ref || '') + '</strong>' +
            (hidePrices() ? '' : ' · ' + money(a.total)) + '</p>' +
            '<p class="text-sm text-gray-500 mb-4">It goes to CHC once a manager approves it on the Orders screen. Nothing has been ordered yet.</p>' +
            '<div class="grid gap-2"><button type="button" data-orders class="w-full bg-blue-700 text-white py-3 rounded-lg">See orders waiting for approval</button>' +
            '<button type="button" data-x class="w-full bg-gray-100 py-3 rounded-lg">Keep shopping</button></div></div>');
        m.box.querySelector('[data-x]').addEventListener('click', function () { m.close(); if (typeof showTab === 'function') showTab('products'); });   // eslint-disable-line no-undef
        m.box.querySelector('[data-orders]').addEventListener('click', function () { m.close(); if (typeof showTab === 'function') showTab('orders'); });   // eslint-disable-line no-undef
        ORules.load();
    };

    /** The orders waiting for approval, above the order history. */
    ORules.renderWaiting = async function () {
        var host = document.getElementById('orules-waiting');
        if (!host || !inStore() || !locId()) return;
        var resp = await api('/approvals?location_id=' + encodeURIComponent(locId()));
        if (!resp.ok) { host.innerHTML = ''; return; }
        var d = await readJson(resp);
        var waiting = d.waiting || [], recent = d.recent || [];
        if (!waiting.length && !recent.length) { host.innerHTML = ''; return; }
        host.innerHTML =
            (waiting.length ? '<div class="rounded-xl border-2 border-amber-300 bg-amber-50 p-3 mb-4">' +
                '<h3 class="font-bold text-amber-900 mb-2"><i class="fas fa-clock mr-1"></i>Waiting for manager approval (' + waiting.length + ')</h3>' +
                waiting.map(function (a) {
                    return '<div class="bg-white rounded-lg border p-3 mb-2 last:mb-0 flex flex-wrap items-center gap-3">' +
                        '<div class="flex-1 min-w-[12rem]"><p class="font-semibold text-gray-800">' + esc(a.contact_name || 'Someone') +
                        ' <span class="text-xs font-mono text-gray-400">' + esc(a.ref) + '</span></p>' +
                        '<p class="text-xs text-gray-500">' + esc(when(a.created_at)) + ' · ' + esc((a.items || []).length) + ' item(s)' +
                        (hidePrices() ? '' : ' · ' + money(a.total)) + '</p>' +
                        '<p class="text-xs text-amber-800">' + esc((a.reasons || []).map(function (r) { return r.title; }).join(' · ')) + '</p></div>' +
                        '<button type="button" data-review="' + esc(a.id) + '" class="bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold px-4 py-2 rounded-lg">Review</button></div>';
                }).join('') + '</div>' : '') +
            (recent.length ? '<details class="mb-4 text-sm"><summary class="cursor-pointer text-gray-600">Recently approved or declined (' + recent.length + ')</summary>' +
                '<div class="mt-2 space-y-1">' + recent.map(function (a) {
                    return '<p class="text-gray-600"><span class="font-mono text-xs text-gray-400">' + esc(a.ref) + '</span> ' + esc(a.contact_name || '') + ' — ' +
                        (a.status === 'released' ? '<span class="text-green-700">approved by ' + esc(a.decided_by_name || '') + '</span>'
                            : '<span class="text-red-700">declined by ' + esc(a.decided_by_name || '') + ': ' + esc(a.decision_reason || '') + '</span>') +
                        ' · ' + esc(when(a.decided_at)) + '</p>';
                }).join('') + '</div></details>' : '');
        host.querySelectorAll('[data-review]').forEach(function (b) {
            b.addEventListener('click', function () { ORules.review(b.getAttribute('data-review')); });
        });
    };

    /** One waiting order: re-priced now; release or decline with a passcode. */
    ORules.review = async function (id) {
        var m = modal('<p class="text-gray-500 py-6 text-center"><i class="fas fa-spinner fa-spin mr-2"></i>Loading…</p>', { sticky: true });
        var resp = await api('/approvals/' + encodeURIComponent(id));
        var d = await readJson(resp);
        if (!resp.ok) { m.box.innerHTML = '<p class="text-red-700">' + esc(d.error || 'Could not load that order.') + '</p><button type="button" data-x class="mt-3 px-4 py-2 rounded-lg bg-gray-100">Close</button>'; m.box.querySelector('[data-x]').addEventListener('click', m.close); return; }
        var a = d.approval, p = d.preview;
        m.box.innerHTML =
            '<h3 class="text-xl font-bold text-gray-800 mb-1">Approve this order?</h3>' +
            '<p class="text-sm text-gray-500 mb-3">From ' + esc(a.contact_name || 'someone') + ' · sent ' + esc(when(a.created_at)) +
            ' · <span class="font-mono">' + esc(a.ref) + '</span>' + (a.po_number ? ' · PO ' + esc(a.po_number) : '') + '</p>' +
            (d.preview_error ? '<p class="rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm p-3 mb-3">' + esc(d.preview_error) + ' Decline it and ask for a new order.</p>' : '') +
            (p ? (p.reasons && p.reasons.length ? reasonsHtml(p.reasons) : '<p class="text-sm text-green-800 bg-green-50 border border-green-200 rounded-lg p-2">No rule stops this order now. Releasing it sends it to CHC.</p>') +
                '<div class="mt-3 rounded-xl border p-3">' + orderTableHtml(p, hidePrices()) +
                (!hidePrices() && Math.abs(Number(p.total) - Number(a.total)) >= 0.01 ? '<p class="text-xs text-amber-800 mt-2">Prices changed since it was sent: it was ' + money(a.total) + ', it is ' + money(p.total) + ' now.</p>' : '') +
                '</div>' : '') +
            (a.notes ? '<p class="text-sm mt-3"><span class="font-semibold">Notes:</span> ' + esc(a.notes) + '</p>' : '') +
            '<div class="mt-4">' + passcodeField('orules-rel-pass', 'Manager: approval passcode') + '</div>' +
            '<p data-err class="hidden mt-2 text-sm text-red-700"></p>' +
            '<div class="mt-4 grid gap-2">' +
            (p ? '<button type="button" data-release class="w-full bg-green-700 hover:bg-green-800 text-white font-semibold py-3 rounded-lg"><i class="fas fa-paper-plane mr-2"></i>Approve and send to CHC</button>' : '') +
            '<button type="button" data-decline class="w-full bg-white border border-red-300 text-red-700 hover:bg-red-50 font-semibold py-3 rounded-lg">Decline</button>' +
            '<button type="button" data-x class="w-full bg-gray-100 hover:bg-gray-200 py-3 rounded-lg">Close</button></div>';
        wireKeys(m.box);
        var err = m.box.querySelector('[data-err]');
        function showErr(t) { err.textContent = t; err.classList.remove('hidden'); }
        function code() { return m.box.querySelector('#orules-rel-pass').value; }
        function busy(on) { m.box.querySelectorAll('button').forEach(function (b) { b.disabled = on; }); }
        m.box.querySelector('[data-x]').addEventListener('click', m.close);
        var rel = m.box.querySelector('[data-release]');
        if (rel) rel.addEventListener('click', async function () {
            if (!code()) { showErr('Enter the approval passcode.'); return; }
            busy(true);
            var r = await api('/approvals/' + encodeURIComponent(id) + '/release', { method: 'POST', body: JSON.stringify({ passcode: code() }) });
            var out = await readJson(r);
            busy(false);
            if (!r.ok) { m.box.querySelector('#orules-rel-pass').value = ''; showErr((out.error || 'Could not release it.') + (out.attempts_left ? ' ' + out.attempts_left + ' tries left.' : '')); return; }
            m.box.innerHTML = '<div class="text-center"><i class="fas fa-circle-check text-4xl text-green-600 mb-3"></i>' +
                '<h3 class="text-xl font-bold mb-1">Sent to CHC</h3><p class="text-gray-600">Order <strong>#' + esc(out.order && out.order.order_number) + '</strong>, approved by ' + esc(out.approved_by) + '.</p>' +
                (out.order && out.order.po_number && out.order.po_source === 'generated' ? '<p class="mt-1">PO <strong class="font-mono">' + esc(out.order.po_number) + '</strong></p>' : '') +
                '<button type="button" data-x class="mt-4 w-full bg-gray-100 py-3 rounded-lg">Done</button></div>';
            m.box.querySelector('[data-x]').addEventListener('click', m.close);
            ORules.load();
            if (typeof loadOrders === 'function') loadOrders();   // eslint-disable-line no-undef
        });
        m.box.querySelector('[data-decline]').addEventListener('click', async function () {
            if (!code()) { showErr('Enter the approval passcode to decline.'); return; }
            // The tap-to-pick reasons from the number pad (no phone keyboard needed), or a prompt.
            var why = window.RAINumpad && typeof window.RAINumpad.choose === 'function'
                ? await window.RAINumpad.choose({ title: 'Why is it declined? The person who asked will see this.',
                    options: ['We have it in stock', 'Too much this month', 'Wrong items', 'Order it next week'], other: 'Or type another reason' })
                : window.prompt('Why is it declined? The person who asked will see this.');
            if (!why) return;
            busy(true);
            var r = await api('/approvals/' + encodeURIComponent(id) + '/decline', { method: 'POST', body: JSON.stringify({ passcode: code(), reason: why }) });
            var out = await readJson(r);
            busy(false);
            if (!r.ok) { m.box.querySelector('#orules-rel-pass').value = ''; showErr((out.error || 'Could not decline it.') + (out.attempts_left ? ' ' + out.attempts_left + ' tries left.' : '')); return; }
            m.close();
            ORules.load();
            ORules.renderWaiting();
        });
    };

    /** The rules screen in the store: owner straight in, anyone else with a passcode. */
    ORules.openRules = function () {
        if (!inStore()) return;
        var s = ORules.status || {};
        var fresh = ORules.rulesToken && (Date.now() - ORules.rulesTokenAt) < 25 * 60 * 1000;
        if (s.is_owner || fresh) { showPanel(); return; }
        var m = modal('<h3 class="text-xl font-bold mb-1">Ordering rules</h3>' +
            '<p class="text-sm text-gray-500 mb-3">For managers. Enter your approval passcode to see and change this shop’s rules.</p>' +
            passcodeField('orules-unlock', 'Approval passcode') +
            '<p data-err class="hidden mt-2 text-sm text-red-700"></p>' +
            '<div class="mt-4 grid grid-cols-2 gap-2"><button type="button" data-x class="py-3 rounded-lg bg-gray-100">Cancel</button>' +
            '<button type="button" data-ok class="py-3 rounded-lg bg-blue-700 text-white font-semibold">Open</button></div>', { sticky: true });
        wireKeys(m.box);
        m.box.querySelector('[data-x]').addEventListener('click', m.close);
        m.box.querySelector('[data-ok]').addEventListener('click', async function () {
            var r = await api('/unlock', { method: 'POST', body: JSON.stringify({ passcode: m.box.querySelector('#orules-unlock').value, location_id: locId() }) });
            var d = await readJson(r);
            if (!r.ok) {
                m.box.querySelector('#orules-unlock').value = '';
                var e = m.box.querySelector('[data-err]');
                e.textContent = (d.error || 'That did not work.') + (d.attempts_left ? ' ' + d.attempts_left + ' tries left.' : '');
                e.classList.remove('hidden');
                return;
            }
            ORules.rulesToken = d.token;
            ORules.rulesTokenAt = Date.now();
            m.close();
            showPanel();
        });
    };

    function showPanel() {
        var m = modal('<div class="flex items-start justify-between gap-3 mb-3"><h3 class="text-xl font-bold text-gray-800"><i class="fas fa-sliders mr-2"></i>Ordering rules</h3>' +
            '<button type="button" data-x class="text-gray-500 hover:text-gray-800 text-2xl leading-none" aria-label="Close">&times;</button></div><div data-panel></div>', { wide: true, sticky: true });
        m.box.querySelector('[data-x]').addEventListener('click', function () { m.close(); ORules.load(); if (typeof loadProducts === 'function') loadProducts(); });   // eslint-disable-line no-undef
        mountPanel(m.box.querySelector('[data-panel]'), {
            loadPath: '/manage',
            showManager: true,
            req: function (path, options) {
                options = options || {};
                var headers = Object.assign({}, options.headers || {});
                if (ORules.rulesToken) headers['X-Rules-Token'] = ORules.rulesToken;
                return api(path, Object.assign({}, options, { headers: headers }));
            },
            onLocked: function () { ORules.rulesToken = null; m.close(); ORules.openRules(); }
        });
    }

    window.ORules = ORules;
})();
