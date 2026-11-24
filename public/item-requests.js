/**
 * public/item-requests.js -- Item requests (migration 072): a customer asking
 * for an item to be added to their catalog. Nothing else goes through here.
 *
 *   ItemRequests.mountStore(el)        the store's "Item requests" screen: ask
 *                                      for an item (with up to 3 photos) and see
 *                                      every request and what happened to it.
 *   ItemRequests.mountConsole(el, opts) the console screen: every request across
 *                                      the customers this account can see, enter
 *                                      one for a customer who called, close it as
 *                                      Complete or Can't supply, and who is emailed.
 *
 * The server decides who may see and do what (routes/item-requests-*.js). Plain
 * DOM, every dynamic string escaped, Tailwind classes both pages load.
 */
(function () {
    'use strict';

    function esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function when(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
    }
    function money(n) { return n == null ? '' : '$' + Number(n).toFixed(2); }
    async function readJson(r) { try { return await r.json(); } catch (_) { return {}; } }

    var STATUS = {
        open: ['Waiting', 'bg-amber-100 text-amber-900'],
        complete: ['Ready to order', 'bg-green-100 text-green-800'],
        cannot_supply: ['Can’t supply', 'bg-gray-200 text-gray-700']
    };
    function pill(s) { var p = STATUS[s] || [s, 'bg-gray-100 text-gray-700']; return '<span class="text-xs font-semibold rounded-full px-2 py-0.5 ' + p[1] + '">' + esc(p[0]) + '</span>'; }

    function photosHtml(photos) {
        if (!photos || !photos.length) return '';
        return '<div class="flex gap-2 mt-2">' + photos.map(function (p) {
            return '<a href="' + esc(p.url) + '" target="_blank" rel="noopener"><img src="' + esc(p.url) + '" alt="Photo" class="w-16 h-16 object-cover rounded-lg border"></a>';
        }).join('') + '</div>';
    }

    /**
     * Shrink a phone photo before it is sent: 1600 px on the long side, JPEG.
     * A 4 MB camera picture becomes a few hundred KB, which uploads quickly on
     * shop Wi-Fi. If the browser cannot read the picture, the original is sent.
     */
    function shrink(file) {
        return new Promise(function (resolve) {
            if (!file || !/^image\//.test(file.type || '')) return resolve(file);
            var url = URL.createObjectURL(file);
            var img = new Image();
            img.onload = function () {
                try {
                    var max = 1600, w = img.naturalWidth, h = img.naturalHeight;
                    var s = Math.min(1, max / Math.max(w, h));
                    var c = document.createElement('canvas');
                    c.width = Math.round(w * s); c.height = Math.round(h * s);
                    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                    c.toBlob(function (b) {
                        URL.revokeObjectURL(url);
                        resolve(b && b.size < file.size ? new File([b], (file.name || 'photo').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file);
                    }, 'image/jpeg', 0.85);
                } catch (_) { URL.revokeObjectURL(url); resolve(file); }
            };
            img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
            img.src = url;
        });
    }

    function photoPicker(root, id) {
        var picked = [];
        var input = root.querySelector('#' + id);
        var list = root.querySelector('[data-thumbs="' + id + '"]');
        function draw() {
            list.innerHTML = picked.map(function (f, i) {
                return '<div class="relative"><img src="' + esc(f._url) + '" alt="" class="w-20 h-20 object-cover rounded-lg border">' +
                    '<button type="button" data-rm="' + i + '" class="absolute -top-2 -right-2 bg-white border rounded-full w-6 h-6 text-xs text-gray-600" aria-label="Remove photo">&times;</button></div>';
            }).join('');
            list.querySelectorAll('[data-rm]').forEach(function (b) {
                b.addEventListener('click', function () { picked.splice(Number(b.getAttribute('data-rm')), 1); draw(); });
            });
        }
        input.addEventListener('change', async function () {
            var files = Array.prototype.slice.call(input.files || []);
            input.value = '';
            for (var i = 0; i < files.length && picked.length < 3; i++) {
                var f = await shrink(files[i]);
                f._url = URL.createObjectURL(f);
                picked.push(f);
            }
            draw();
        });
        return { files: function () { return picked; }, clear: function () { picked = []; draw(); } };
    }

    // ------------------------------------------------------------------
    // THE STORE
    // ------------------------------------------------------------------
    function storeState() { return typeof state === 'object' && state ? state : null; }   // eslint-disable-line no-undef

    function mountStore(root) {
        var s = storeState();
        if (!s || !s.slug || !root) return;
        // Showing the tab again refreshes the list and keeps a half-typed request.
        if (root.__irLoad && root.__irSlug === s.slug) { root.__irLoad(); return; }
        var base = '/api/store/' + encodeURIComponent(s.slug) + '/item-requests';
        var auth = function () { return { 'Authorization': 'Bearer ' + s.token }; };
        var me = s.companyUser || {};
        var guessName = me.name || (document.getElementById('checkout-name') || {}).value || '';
        var guessEmail = me.email || (document.getElementById('checkout-email') || {}).value || '';

        root.innerHTML =
            '<div class="grid lg:grid-cols-5 gap-6">' +
            '<form data-form class="lg:col-span-2 bg-white rounded-xl shadow-sm border p-4 sm:p-5 space-y-3 self-start" novalidate>' +
            '<h3 class="text-lg font-bold text-gray-800">Add an item to your list</h3>' +
            '<p class="text-sm text-gray-500">Need something that isn’t in your catalog? Ask here instead of calling or texting. We’ll add it and email you when it’s ready to order. For prices or orders, contact CHC as usual.</p>' +
            field('ir-item', 'What do you need?', 'text', 'e.g. Norton SpeedGrip 5 min adhesive', true) +
            '<div class="grid grid-cols-2 gap-3">' + field('ir-part', 'Part number', 'text', 'if you have it') + field('ir-brand', 'Brand', 'text', '') + '</div>' +
            field('ir-qty', 'How many', 'text', 'e.g. 2 cases a month') +
            '<div><label for="ir-notes" class="block text-sm font-semibold text-gray-700 mb-1">Notes</label>' +
            '<textarea id="ir-notes" rows="3" maxlength="2000" class="w-full border rounded-lg px-3 py-2" placeholder="Anything that helps us find the right one"></textarea></div>' +
            '<div><span class="block text-sm font-semibold text-gray-700 mb-1">Photos <span class="font-normal text-gray-400">(up to 3: the label, the old can)</span></span>' +
            '<label for="ir-photos" class="inline-flex items-center gap-2 bg-gray-100 hover:bg-gray-200 rounded-lg px-3 py-2 text-sm cursor-pointer"><i class="fas fa-camera"></i> Add photos</label>' +
            '<input id="ir-photos" type="file" accept="image/*" multiple class="sr-only">' +
            '<div data-thumbs="ir-photos" class="flex gap-3 mt-2"></div></div>' +
            '<div class="grid grid-cols-2 gap-3">' + field('ir-name', 'Your name', 'text', '', false, guessName) + field('ir-email', 'Your email', 'email', 'for the "ready" email', false, guessEmail) + '</div>' +
            '<p data-msg class="hidden text-sm"></p>' +
            '<button type="submit" class="w-full bg-blue-700 hover:bg-blue-800 text-white font-semibold py-3 rounded-lg"><i class="fas fa-paper-plane mr-2"></i>Send request</button>' +
            '</form>' +
            '<div class="lg:col-span-3"><h3 class="text-lg font-bold text-gray-800 mb-3">Your requests</h3><div data-list class="space-y-3"></div></div>' +
            '</div>';

        var picker = photoPicker(root, 'ir-photos');
        var form = root.querySelector('[data-form]');
        var msg = root.querySelector('[data-msg]');
        function say(t, bad) { msg.textContent = t; msg.className = 'text-sm ' + (bad ? 'text-red-700' : 'text-green-700'); }

        form.addEventListener('submit', async function (e) {
            e.preventDefault();
            var item = root.querySelector('#ir-item').value.trim();
            if (!item) { say('Say what item you need.', true); root.querySelector('#ir-item').focus(); return; }
            var fd = new FormData();
            fd.append('item_name', item);
            [['part_number', 'ir-part'], ['brand', 'ir-brand'], ['quantity', 'ir-qty'], ['notes', 'ir-notes'],
             ['requested_by_name', 'ir-name'], ['requested_by_email', 'ir-email']].forEach(function (p) {
                var v = root.querySelector('#' + p[1]).value.trim(); if (v) fd.append(p[0], v);
            });
            if (s.location && s.location.id) fd.append('location_id', s.location.id);
            picker.files().forEach(function (f) { fd.append('photos', f, f.name || 'photo.jpg'); });
            var btn = form.querySelector('button[type=submit]');
            btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Sending…';
            try {
                var r = await fetch(base, { method: 'POST', headers: auth(), body: fd });
                var d = await readJson(r);
                if (!r.ok) { say(d.error || 'That did not send. Try again.', true); return; }
                say('Sent as ' + (d.request.ref || 'a new request') + '. We’ll email you when it’s ready to order.');
                ['ir-item', 'ir-part', 'ir-brand', 'ir-qty', 'ir-notes'].forEach(function (id) { root.querySelector('#' + id).value = ''; });
                picker.clear();
                load();
            } catch (_) { say('No connection. Your request was not sent.', true); }
            finally { btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane mr-2"></i>Send request'; }
        });

        async function load() {
            var host = root.querySelector('[data-list]');
            host.innerHTML = '<p class="text-gray-400 text-sm"><i class="fas fa-spinner fa-spin mr-1"></i>Loading…</p>';
            var r = await fetch(base, { headers: auth() });
            var d = await readJson(r);
            if (!r.ok) { host.innerHTML = '<p class="text-red-700 text-sm">' + esc(d.error || 'Could not load your requests.') + '</p>'; return; }
            var list = d.requests || [];
            if (!list.length) { host.innerHTML = '<p class="text-gray-500 text-sm bg-white border rounded-xl p-4">No requests yet. Items you ask us to add show here, with what happened to each.</p>'; return; }
            host.innerHTML = list.map(function (q) {
                return '<div class="bg-white rounded-xl border p-4">' +
                    '<div class="flex flex-wrap items-start justify-between gap-2"><div class="min-w-0">' +
                    '<p class="font-semibold text-gray-800">' + esc(q.item_name) + '</p>' +
                    '<p class="text-xs text-gray-500">' + [q.ref, q.part_number, q.brand, q.quantity ? 'Qty ' + q.quantity : '', when(q.created_at), q.location_name, q.requested_by_name ? 'by ' + q.requested_by_name : '']
                        .filter(Boolean).map(esc).join(' · ') + '</p></div>' + pill(q.status) + '</div>' +
                    (q.notes ? '<p class="text-sm text-gray-600 mt-1 whitespace-pre-wrap">' + esc(q.notes) + '</p>' : '') +
                    photosHtml(q.photos) +
                    (q.staff_note ? '<p class="text-sm mt-2 ' + (q.status === 'complete' ? 'text-green-800' : 'text-gray-700') + '"><strong>' + (q.status === 'complete' ? 'Note: ' : 'Why: ') + '</strong>' + esc(q.staff_note) + '</p>' : '') +
                    (q.status === 'complete' && q.product ? '<div class="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-green-50 border border-green-200 p-2">' +
                        '<span class="text-sm text-green-900 flex-1 min-w-0">On your list as <strong>' + esc(q.product.name) + '</strong> ' + esc(q.product.sku || '') + (q.product.price != null ? ' · ' + money(q.product.price) : '') + '</span>' +
                        '<button type="button" data-add="' + esc(q.product.id) + '" class="bg-green-700 hover:bg-green-800 text-white text-sm font-semibold px-3 py-2 rounded-lg"><i class="fas fa-cart-plus mr-1"></i>Add to cart</button></div>' : '') +
                    '</div>';
            }).join('');
            host.querySelectorAll('[data-add]').forEach(function (b) {
                b.addEventListener('click', function () {
                    if (typeof addToCart === 'function') { addToCart(b.getAttribute('data-add')); b.innerHTML = '<i class="fas fa-check mr-1"></i>Added'; b.disabled = true; }   // eslint-disable-line no-undef
                });
            });
        }
        root.__irLoad = load; root.__irSlug = s.slug;
        load();
    }

    function field(id, label, type, ph, required, value) {
        return '<div><label for="' + id + '" class="block text-sm font-semibold text-gray-700 mb-1">' + esc(label) + (required ? ' <span class="text-red-600">*</span>' : '') + '</label>' +
            '<input id="' + id + '" type="' + type + '" maxlength="200" class="w-full border rounded-lg px-3 py-2" placeholder="' + esc(ph || '') + '" value="' + esc(value || '') + '"' + (required ? ' required' : '') + '></div>';
    }

    // ------------------------------------------------------------------
    // THE CONSOLE
    // ------------------------------------------------------------------
    var VIA = [['phone', 'Phone call'], ['email', 'Email'], ['text', 'Text message'], ['in_person', 'In person'], ['other', 'Other']];

    function mountConsole(root, opts) {
        var req = opts.req;          // (path, options) -> fetch Response for /api/admin/item-requests + path
        var raw = opts.raw;          // (path, options) -> fetch Response without a JSON content type (multipart)
        var filter = { status: 'open', company_id: '', q: '' };
        var data = { requests: [], companies: [] };

        root.innerHTML =
            '<div class="flex flex-wrap items-center gap-3 mb-4">' +
            '<select data-f="status" class="border rounded-lg px-3 py-2 text-sm bg-white" aria-label="Status">' +
            '<option value="open">Waiting</option><option value="complete">Complete</option><option value="cannot_supply">Can’t supply</option><option value="all">All</option></select>' +
            '<select data-f="company_id" class="border rounded-lg px-3 py-2 text-sm bg-white" aria-label="Customer"><option value="">All customers</option></select>' +
            '<input data-f="q" type="search" placeholder="Search item, part number, brand" class="border rounded-lg px-3 py-2 text-sm flex-1 min-w-[12rem]">' +
            '<button type="button" data-new class="bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold px-4 py-2 rounded-lg"><i class="fas fa-plus mr-1"></i>Enter a request</button>' +
            '<button type="button" data-inbox class="text-sm text-gray-600 hover:text-blue-700 px-2 py-2"><i class="fas fa-envelope mr-1"></i>Who is emailed</button>' +
            '</div>' +
            '<p class="text-sm text-gray-500 mb-4">Requests to add an item to a customer’s catalog, in one place, by customer. Shops ask from their store; enter one here when a customer calls, emails or texts. Add the item to their list, then Complete tells them it’s ready to order; Can’t supply tells them why.</p>' +
            '<div data-list></div>';

        var t = null;
        root.querySelectorAll('[data-f]').forEach(function (el) {
            el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', function () {
                filter[el.getAttribute('data-f')] = el.value;
                clearTimeout(t); t = setTimeout(load, el.tagName === 'INPUT' ? 300 : 0);
            });
        });
        root.querySelector('[data-new]').addEventListener('click', openNew);
        root.querySelector('[data-inbox]').addEventListener('click', openInbox);

        async function load() {
            var host = root.querySelector('[data-list]');
            host.innerHTML = '<p class="text-gray-400 text-sm"><i class="fas fa-spinner fa-spin mr-1"></i>Loading…</p>';
            var q = new URLSearchParams({ status: filter.status });
            if (filter.company_id) q.set('company_id', filter.company_id);
            if (filter.q) q.set('q', filter.q);
            var r = await req('?' + q.toString());
            var d = await readJson(r);
            if (!r.ok) { host.innerHTML = '<p class="text-red-700 bg-red-50 border border-red-200 rounded-lg p-3 text-sm">' + esc(d.error || 'Could not load item requests.') + '</p>'; return; }
            data = d;
            if (opts.onCount) opts.onCount(d.counts ? d.counts.open : 0);
            var sel = root.querySelector('[data-f="company_id"]');
            if (sel.options.length <= 1) {
                sel.innerHTML = '<option value="">All customers</option>' + (d.companies || []).map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>'; }).join('');
                sel.value = filter.company_id;
            }
            var list = d.requests || [];
            if (!list.length) { host.innerHTML = '<p class="text-gray-500 text-sm bg-white border rounded-xl p-6 text-center">Nothing here' + (filter.status === 'open' ? ': no items are waiting to be added.' : '.') + '</p>'; return; }
            host.innerHTML = '<div class="space-y-3">' + list.map(card).join('') + '</div>';
            host.querySelectorAll('[data-close]').forEach(function (b) {
                b.addEventListener('click', function () { openClose(b.getAttribute('data-close'), b.getAttribute('data-to')); });
            });
            host.querySelectorAll('[data-reopen]').forEach(function (b) {
                b.addEventListener('click', async function () {
                    var r2 = await req('/' + encodeURIComponent(b.getAttribute('data-reopen')), { method: 'PUT', body: JSON.stringify({ status: 'open' }) });
                    if (r2.ok) load();
                });
            });
        }

        function card(q) {
            var via = { phone: 'phone call', email: 'email', text: 'text', in_person: 'in person', other: 'other' };
            return '<div class="bg-white rounded-xl border p-4">' +
                '<div class="flex flex-wrap items-start gap-3"><div class="flex-1 min-w-[14rem]">' +
                '<p class="text-xs font-semibold text-blue-700">' + esc(q.company_name) + (q.location_name ? ' · ' + esc(q.location_name) : '') + '</p>' +
                '<p class="font-semibold text-gray-800">' + esc(q.item_name) + '</p>' +
                '<p class="text-xs text-gray-500">' + [q.ref, q.part_number, q.brand, q.quantity ? 'Qty ' + q.quantity : '', when(q.created_at)].filter(Boolean).map(esc).join(' · ') + '</p>' +
                '<p class="text-xs text-gray-500">' + (q.source === 'staff'
                    ? 'Entered by ' + esc(q.entered_by_name || 'staff') + ' from a ' + esc(via[q.received_via] || 'other')
                    : 'From the store') + (q.requested_by_name || q.requested_by_email ? ' · asked by ' + esc([q.requested_by_name, q.requested_by_email].filter(Boolean).join(', ')) : '') + '</p>' +
                (q.notes ? '<p class="text-sm text-gray-700 mt-1 whitespace-pre-wrap">' + esc(q.notes) + '</p>' : '') +
                photosHtml(q.photos) +
                (q.status !== 'open' ? '<p class="text-sm mt-2 text-gray-700">' + pill(q.status) + ' by ' + esc(q.closed_by_name || '') + ' ' + esc(when(q.closed_at)) +
                    (q.product ? ' · linked to <strong>' + esc(q.product.name) + '</strong> ' + esc(q.product.sku || '') : '') +
                    (q.staff_note ? '<br><span class="text-gray-600">' + esc(q.staff_note) + '</span>' : '') +
                    (q.customer_notified_at ? '<br><span class="text-xs text-gray-400">Customer emailed ' + esc(when(q.customer_notified_at)) + '</span>' : '') + '</p>' : '') +
                '</div><div class="flex flex-col gap-2">' +
                (q.status === 'open'
                    ? '<button type="button" data-close="' + esc(q.id) + '" data-to="complete" class="bg-green-700 hover:bg-green-800 text-white text-sm font-semibold px-4 py-2 rounded-lg"><i class="fas fa-check mr-1"></i>Complete</button>' +
                      '<button type="button" data-close="' + esc(q.id) + '" data-to="cannot_supply" class="bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 text-sm px-4 py-2 rounded-lg">Can’t supply</button>'
                    : '<button type="button" data-reopen="' + esc(q.id) + '" class="text-sm text-gray-500 hover:text-blue-700">Reopen</button>') +
                '</div></div></div>';
        }

        function modal(html) {
            var back = document.createElement('div');
            back.className = 'fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4';
            back.innerHTML = '<div class="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[92vh] overflow-y-auto p-6">' + html + '</div>';
            document.body.appendChild(back);
            back.addEventListener('click', function (e) { if (e.target === back) back.remove(); });
            return { box: back.firstChild, close: function () { back.remove(); } };
        }

        function openClose(id, to) {
            var q = (data.requests || []).find(function (x) { return x.id === id; });
            if (!q) return;
            var done = to === 'complete';
            var m = modal('<h3 class="text-xl font-bold mb-1">' + (done ? 'Complete: added to their catalog' : 'Can’t supply') + '</h3>' +
                '<p class="text-sm text-gray-500 mb-4">' + esc(q.company_name) + ' asked for <strong>' + esc(q.item_name) + '</strong>' + (q.part_number ? ' (' + esc(q.part_number) + ')' : '') + '.</p>' +
                (done ? '<label for="irc-find" class="block text-sm font-semibold text-gray-700 mb-1">Link the item on their list <span class="font-normal text-gray-400">(shows an Add to cart button)</span></label>' +
                    '<input id="irc-find" type="search" class="w-full border rounded-lg px-3 py-2" placeholder="Search their list by name or part number" value="' + esc(q.part_number || '') + '">' +
                    '<div data-results class="mt-2 space-y-1 max-h-48 overflow-y-auto"></div><input type="hidden" id="irc-product">' +
                    '<p class="text-xs text-gray-500 mt-1">Add the item to their list first if it isn’t there (Products, or Customer Pricing).</p>' : '') +
                '<label for="irc-note" class="block text-sm font-semibold text-gray-700 mt-4 mb-1">' + (done ? 'Note to the customer (optional)' : 'Why (the customer sees this)') + '</label>' +
                '<textarea id="irc-note" rows="3" maxlength="1000" class="w-full border rounded-lg px-3 py-2" placeholder="' + (done ? 'e.g. Added at $90.99 each' : 'e.g. Discontinued by the maker; try X instead') + '"></textarea>' +
                '<label class="flex items-center gap-2 mt-3 text-sm"><input type="checkbox" id="irc-notify" checked> Email the customer' + (q.requested_by_email ? ' (' + esc(q.requested_by_email) + ')' : ' (the shop’s contacts)') + '</label>' +
                '<p data-err class="hidden mt-2 text-sm text-red-700"></p>' +
                '<div class="mt-5 flex justify-end gap-2"><button type="button" data-x class="px-4 py-2 rounded-lg bg-gray-100">Cancel</button>' +
                '<button type="button" data-ok class="px-4 py-2 rounded-lg text-white font-semibold ' + (done ? 'bg-green-700 hover:bg-green-800' : 'bg-gray-700 hover:bg-gray-800') + '">' + (done ? 'Mark complete' : 'Mark can’t supply') + '</button></div>');
            m.box.querySelector('[data-x]').addEventListener('click', m.close);
            if (done) {
                var find = m.box.querySelector('#irc-find'), results = m.box.querySelector('[data-results]'), hid = m.box.querySelector('#irc-product');
                var tt = null;
                var search = async function () {
                    var term = find.value.trim();
                    if (term.length < 2) { results.innerHTML = ''; return; }
                    var r = await req('/products?' + new URLSearchParams({ company_id: q.company_id, q: term }).toString());
                    var d = await readJson(r);
                    results.innerHTML = (d.products || []).map(function (p) {
                        return '<label class="flex items-center gap-2 text-sm p-1.5 rounded hover:bg-gray-50 cursor-pointer"><input type="radio" name="irc-pick" value="' + esc(p.id) + '">' +
                            '<span class="flex-1 min-w-0 truncate">' + esc(p.name) + ' <span class="text-gray-400">' + esc(p.sku || '') + '</span></span>' +
                            '<span class="text-gray-500 tabular-nums">' + (p.price_on_request ? 'Call' : money(p.price)) + '</span></label>';
                    }).join('') || '<p class="text-xs text-gray-500">Nothing on their list matches.</p>';
                    results.querySelectorAll('input[name=irc-pick]').forEach(function (i) { i.addEventListener('change', function () { hid.value = i.value; }); });
                };
                find.addEventListener('input', function () { clearTimeout(tt); tt = setTimeout(search, 250); });
                search();
            }
            m.box.querySelector('[data-ok]').addEventListener('click', async function () {
                var body = { status: to, staff_note: m.box.querySelector('#irc-note').value, notify: m.box.querySelector('#irc-notify').checked };
                if (done && m.box.querySelector('#irc-product').value) body.product_id = m.box.querySelector('#irc-product').value;
                var r = await req('/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(body) });
                var d = await readJson(r);
                if (!r.ok) { var e = m.box.querySelector('[data-err]'); e.textContent = d.error || 'That did not save.'; e.classList.remove('hidden'); return; }
                m.close();
                if (opts.toast) opts.toast(d.message || 'Saved.');
                load();
            });
        }

        function openNew() {
            var cos = data.companies || [];
            var m = modal('<h3 class="text-xl font-bold mb-1">Enter a request</h3>' +
                '<p class="text-sm text-gray-500 mb-4">A customer called, emailed, texted or asked in person for an item to be added to their catalog. It joins the list and the request inbox is emailed.</p>' +
                '<div class="grid sm:grid-cols-2 gap-3">' +
                '<div><label for="irn-co" class="block text-sm font-semibold text-gray-700 mb-1">Customer <span class="text-red-600">*</span></label>' +
                '<select id="irn-co" class="w-full border rounded-lg px-3 py-2"><option value="">Choose…</option>' + cos.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>'; }).join('') + '</select></div>' +
                '<div><label for="irn-loc" class="block text-sm font-semibold text-gray-700 mb-1">Shop</label><select id="irn-loc" class="w-full border rounded-lg px-3 py-2"><option value="">Any / not sure</option></select></div>' +
                '</div>' +
                '<div class="mt-3">' + field('irn-item', 'Item', 'text', 'What they asked for', true) + '</div>' +
                '<div class="grid grid-cols-2 gap-3 mt-3">' + field('irn-part', 'Part number', 'text', '') + field('irn-brand', 'Brand', 'text', '') + '</div>' +
                '<div class="grid grid-cols-2 gap-3 mt-3">' + field('irn-qty', 'How many', 'text', '') +
                '<div><label for="irn-via" class="block text-sm font-semibold text-gray-700 mb-1">How it came in</label><select id="irn-via" class="w-full border rounded-lg px-3 py-2">' +
                VIA.map(function (v) { return '<option value="' + v[0] + '">' + esc(v[1]) + '</option>'; }).join('') + '</select></div></div>' +
                '<div class="grid grid-cols-2 gap-3 mt-3">' + field('irn-name', 'Who asked', 'text', '') + field('irn-email', 'Their email', 'email', 'for the "ready" email') + '</div>' +
                '<div class="mt-3"><label for="irn-notes" class="block text-sm font-semibold text-gray-700 mb-1">Notes</label><textarea id="irn-notes" rows="2" maxlength="2000" class="w-full border rounded-lg px-3 py-2"></textarea></div>' +
                '<div class="mt-3"><label for="irn-photos" class="inline-flex items-center gap-2 bg-gray-100 hover:bg-gray-200 rounded-lg px-3 py-2 text-sm cursor-pointer"><i class="fas fa-camera"></i> Add photos (up to 3)</label>' +
                '<input id="irn-photos" type="file" accept="image/*" multiple class="sr-only"><div data-thumbs="irn-photos" class="flex gap-3 mt-2"></div></div>' +
                '<p data-err class="hidden mt-2 text-sm text-red-700"></p>' +
                '<div class="mt-5 flex justify-end gap-2"><button type="button" data-x class="px-4 py-2 rounded-lg bg-gray-100">Cancel</button>' +
                '<button type="button" data-ok class="px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white font-semibold">Add request</button></div>');
            var picker = photoPicker(m.box, 'irn-photos');
            var co = m.box.querySelector('#irn-co'), loc = m.box.querySelector('#irn-loc');
            co.addEventListener('change', function () {
                var c = cos.find(function (x) { return x.id === co.value; });
                loc.innerHTML = '<option value="">Any / not sure</option>' + ((c && c.locations) || []).map(function (l) { return '<option value="' + esc(l.id) + '">' + esc(l.name) + '</option>'; }).join('');
            });
            if (filter.company_id) { co.value = filter.company_id; co.dispatchEvent(new Event('change')); }
            m.box.querySelector('[data-x]').addEventListener('click', m.close);
            m.box.querySelector('[data-ok]').addEventListener('click', async function () {
                var err = m.box.querySelector('[data-err]');
                if (!co.value) { err.textContent = 'Choose the customer.'; err.classList.remove('hidden'); return; }
                var fd = new FormData();
                fd.append('company_id', co.value);
                if (loc.value) fd.append('location_id', loc.value);
                [['item_name', 'irn-item'], ['part_number', 'irn-part'], ['brand', 'irn-brand'], ['quantity', 'irn-qty'], ['received_via', 'irn-via'],
                 ['requested_by_name', 'irn-name'], ['requested_by_email', 'irn-email'], ['notes', 'irn-notes']].forEach(function (p) {
                    var v = m.box.querySelector('#' + p[1]).value.trim(); if (v) fd.append(p[0], v);
                });
                picker.files().forEach(function (f) { fd.append('photos', f, f.name || 'photo.jpg'); });
                var r = await raw('', { method: 'POST', body: fd });
                var d = await readJson(r);
                if (!r.ok) { err.textContent = d.error || 'That did not save.'; err.classList.remove('hidden'); return; }
                m.close();
                if (opts.toast) opts.toast(d.message || 'Added.');
                load();
            });
        }

        async function openInbox() {
            var r = await req('/settings');
            var d = await readJson(r);
            var m = modal('<h3 class="text-xl font-bold mb-1">Who is emailed about new requests</h3>' +
                '<p class="text-sm text-gray-500 mb-3">Every new request, from a store or entered here, goes to these addresses. Add someone while you’re away; take them off when you’re back.</p>' +
                '<label for="iri-emails" class="block text-sm font-semibold text-gray-700 mb-1">Emails (one per line or comma-separated)</label>' +
                '<textarea id="iri-emails" rows="4" class="w-full border rounded-lg px-3 py-2 font-mono text-sm" ' + (d.can_edit ? '' : 'disabled') + '>' + esc((d.notify_emails || []).join('\n')) + '</textarea>' +
                (d.can_edit ? '' : '<p class="text-xs text-gray-500 mt-1">Only an admin can change this list.</p>') +
                '<p data-err class="hidden mt-2 text-sm text-red-700"></p>' +
                '<div class="mt-5 flex justify-end gap-2"><button type="button" data-x class="px-4 py-2 rounded-lg bg-gray-100">Close</button>' +
                (d.can_edit ? '<button type="button" data-ok class="px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white font-semibold">Save</button>' : '') + '</div>');
            m.box.querySelector('[data-x]').addEventListener('click', m.close);
            var ok = m.box.querySelector('[data-ok]');
            if (ok) ok.addEventListener('click', async function () {
                var r2 = await req('/settings', { method: 'PUT', body: JSON.stringify({ notify_emails: m.box.querySelector('#iri-emails').value }) });
                var d2 = await readJson(r2);
                if (!r2.ok) { var e = m.box.querySelector('[data-err]'); e.textContent = d2.error || 'That did not save.'; e.classList.remove('hidden'); return; }
                m.close();
                if (opts.toast) opts.toast(d2.message || 'Saved.');
            });
        }

        load();
        return { reload: load };
    }

    window.ItemRequests = { mountStore: mountStore, mountConsole: mountConsole };
})();
