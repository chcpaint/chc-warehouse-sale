/**
 * public/people-activity.js
 *
 * The "People & activity" panel: who ordered, how much each person spends, who
 * signed in, and named groups of people. One widget, mounted by both the CHC
 * console (admin/index.html) and the customer's own store (store.html, owner
 * only). It knows nothing about either page: the host hands it two small
 * request functions and it draws everything else.
 *
 *   PeopleActivity.mount(element, {
 *     req:            (path, options) => Promise<Response>   // .../people + path
 *     usersReq:       (path, options) => Promise<Response>   // .../users  + path  (assign a group)
 *     loadLocations:  async () => [{ id, name }]             // shop filter
 *     staff:          true | false                           // wording only
 *   })
 *
 * Plain DOM, no framework, every dynamic string escaped. Styled with the
 * Tailwind classes both pages already load.
 */
(function () {
    'use strict';

    var EVENTS = {
        login: ['Signed in', 'bg-green-100 text-green-800'],
        password_set: ['Set a password', 'bg-green-100 text-green-800'],
        password_reset: ['Reset password', 'bg-green-100 text-green-800'],
        failed: ['Wrong password', 'bg-red-100 text-red-800'],
        disabled: ['Disabled account', 'bg-red-100 text-red-800'],
        shared_refused: ['Shared code blocked', 'bg-yellow-100 text-yellow-800']
    };

    var PERIODS = [
        ['this_month', 'This month'], ['last_month', 'Last month'], ['last_30', 'Last 30 days'],
        ['last_90', 'Last 90 days'], ['ytd', 'Year to date'], ['all', 'All time']
    ];

    function esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function money(n) {
        if (n === null || n === undefined) return '—';
        return Number(n).toLocaleString('en-CA', { style: 'currency', currency: 'CAD' });
    }
    function when(iso) {
        if (!iso) return 'Never';
        var d = new Date(iso);
        return isNaN(d) ? '—' : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    }
    function day(iso) {
        if (!iso) return '—';
        var d = new Date(iso);
        return isNaN(d) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }
    function device(ua) {
        ua = String(ua || '');
        if (!ua) return '';
        var browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
        var os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
        return browser + (os ? ' on ' + os : '');
    }

    /** Period name -> { from, to } as ISO strings (null = open ended), in the viewer's own time zone. */
    function periodRange(name, now) {
        now = now || new Date();
        var y = now.getFullYear(), m = now.getMonth();
        var startOfDay = function (d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
        var iso = function (d) { return d.toISOString(); };
        switch (name) {
            case 'this_month': return { from: iso(new Date(y, m, 1)), to: null };
            case 'last_month': return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 1, 0, 0, 0, -1)) };
            case 'last_30': return { from: iso(new Date(startOfDay(now).getTime() - 29 * 864e5)), to: null };
            case 'last_90': return { from: iso(new Date(startOfDay(now).getTime() - 89 * 864e5)), to: null };
            case 'ytd': return { from: iso(new Date(y, 0, 1)), to: null };
            default: return { from: null, to: null };
        }
    }

    function csvCell(v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }

    function mount(host, opts) {
        var st = {
            tab: 'activity', period: 'this_month', location: '', group: '',
            report: null, logins: null, groups: null, users: null, locations: [],
            detail: null, sort: { key: 'spend', dir: -1 }, moduleOff: false, error: null, busy: false
        };

        function qs() {
            var r = periodRange(st.period), p = [];
            if (r.from) p.push('from=' + encodeURIComponent(r.from));
            if (r.to) p.push('to=' + encodeURIComponent(r.to));
            if (st.location) p.push('location_id=' + encodeURIComponent(st.location));
            if (st.group) p.push('group_id=' + encodeURIComponent(st.group));
            return p.length ? '?' + p.join('&') : '';
        }

        function json(resp) { return resp.json().catch(function () { return {}; }); }

        function fail(resp, data) {
            if (data && data.module_off) { st.moduleOff = true; return; }
            st.error = (data && data.error) || 'Something went wrong. Please try again.';
        }

        async function loadActivity() {
            st.busy = true; st.error = null; draw();
            try {
                var resp = await opts.req('/activity' + qs());
                var data = await json(resp);
                if (!resp.ok) fail(resp, data); else { st.report = data; st.moduleOff = false; }
            } catch (e) { st.error = 'Connection error. Please try again.'; }
            st.busy = false; draw();
        }

        async function loadGroups() {
            try {
                var gr = await opts.req('/groups'); var gd = await json(gr);
                if (gr.ok) st.groups = gd.groups || []; else fail(gr, gd);
                var ur = await opts.usersReq(''); var ud = await json(ur);
                if (ur.ok) st.users = ud.users || [];
            } catch (e) { st.error = 'Connection error. Please try again.'; }
            draw();
        }

        async function loadLogins() {
            try {
                var r = periodRange(st.period);
                var p = ['limit=300'];
                if (r.from) p.push('from=' + encodeURIComponent(r.from));
                if (r.to) p.push('to=' + encodeURIComponent(r.to));
                var resp = await opts.req('/logins?' + p.join('&')); var data = await json(resp);
                if (resp.ok) st.logins = data.logins || []; else fail(resp, data);
            } catch (e) { st.error = 'Connection error. Please try again.'; }
            draw();
        }

        async function openPerson(userId) {
            if (!userId) return;
            st.detail = { id: userId, loading: true }; draw();
            try {
                var r = periodRange(st.period), p = [];
                if (r.from) p.push('from=' + encodeURIComponent(r.from));
                if (r.to) p.push('to=' + encodeURIComponent(r.to));
                var resp = await opts.req('/users/' + encodeURIComponent(userId) + (p.length ? '?' + p.join('&') : ''));
                var data = await json(resp);
                st.detail = resp.ok ? Object.assign({ id: userId }, data) : { id: userId, error: data.error || 'Could not load that person.' };
            } catch (e) { st.detail = { id: userId, error: 'Connection error.' }; }
            draw();
            var el = host.querySelector('[data-detail]');
            if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        // ------------------------------------------------------------------ drawing

        function select(attr, value, options) {
            return '<select data-field="' + attr + '" class="border rounded-lg px-2 py-1.5 text-sm bg-white">' +
                options.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(value) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') +
                '</select>';
        }

        function controls() {
            var shops = [['', 'All shops']].concat(st.locations.map(function (l) { return [l.id, l.name]; }));
            var groups = [['', 'All groups']].concat((st.groups || []).map(function (g) { return [g.id, g.name]; }));
            var onGroupsTab = st.tab === 'groups';
            return '<div class="flex flex-wrap items-center gap-2 mb-4">' +
                (onGroupsTab ? '' : select('period', st.period, PERIODS)) +
                (!onGroupsTab && st.tab === 'activity' && st.locations.length > 1 ? select('location', st.location, shops) : '') +
                (!onGroupsTab && st.tab === 'activity' && groups.length > 1 ? select('group', st.group, groups) : '') +
                '<button data-action="refresh" class="ml-auto text-sm text-blue-700 hover:text-blue-900"><i class="fas fa-rotate mr-1"></i>Refresh</button>' +
                (st.tab === 'activity' && st.report ? '<button data-action="csv" class="text-sm text-blue-700 hover:text-blue-900"><i class="fas fa-download mr-1"></i>Export CSV</button>' : '') +
                '</div>';
        }

        function tabs() {
            var t = [['activity', 'Who orders'], ['logins', 'Sign-ins'], ['groups', 'Groups']];
            return '<div class="flex gap-1 border-b mb-4">' + t.map(function (x) {
                var on = st.tab === x[0];
                return '<button data-tab="' + x[0] + '" class="px-4 py-2 text-sm font-semibold -mb-px border-b-2 ' +
                    (on ? 'border-blue-700 text-blue-800' : 'border-transparent text-gray-500 hover:text-gray-800') + '">' + x[1] + '</button>';
            }).join('') + '</div>';
        }

        function card(label, value, sub) {
            return '<div class="bg-white rounded-xl border p-3"><p class="text-xs text-gray-400 uppercase">' + esc(label) + '</p>' +
                '<p class="text-xl font-bold text-gray-800 mt-0.5">' + value + '</p>' +
                (sub ? '<p class="text-xs text-gray-400 mt-0.5">' + sub + '</p>' : '') + '</div>';
        }

        function sortedPeople() {
            var k = st.sort.key, d = st.sort.dir;
            var val = function (p) {
                var v = p[k];
                if (k === 'name' || k === 'group' || k === 'location') return String(v || '').toLowerCase();
                if (k === 'last_order_at' || k === 'last_login') return v ? new Date(v).getTime() : 0;
                return Number(v) || 0;
            };
            return st.report.people.slice().sort(function (a, b) {
                var x = val(a), y = val(b);
                return (x < y ? -1 : x > y ? 1 : 0) * d || String(a.name).localeCompare(String(b.name));
            });
        }

        function th(label, key, right) {
            var on = st.sort.key === key;
            return '<th class="px-3 py-2 text-xs font-semibold text-gray-500 uppercase ' + (right ? 'text-right' : 'text-left') + '">' +
                '<button data-sort="' + key + '" class="uppercase ' + (on ? 'text-blue-800' : '') + '">' + label + (on ? (st.sort.dir < 0 ? ' ▾' : ' ▴') : '') + '</button></th>';
        }

        function activityView() {
            var r = st.report;
            if (!r) return '<p class="text-gray-400 text-center py-10">Loading…</p>';
            var s = r.summary, hidden = r.pricing_hidden;
            var out = '<div class="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">' +
                card('Orders', s.orders) +
                (hidden ? '' : card('Spend', money(s.spend), 'avg order ' + money(s.avg_order))) +
                card('People ordering', s.people_ordering, 'of ' + r.people.filter(function (p) { return p.status !== 'removed' && p.is_active; }).length + ' active') +
                card('Sign-ins', s.logins, s.failed_logins ? s.failed_logins + ' failed' : 'none failed') +
                card('Units', s.units) + '</div>';

            if (s.shared_login_orders) {
                out += '<div class="mb-3 p-3 rounded-lg bg-yellow-50 border border-yellow-200 text-sm text-yellow-900">' +
                    '<i class="fas fa-triangle-exclamation mr-1"></i><strong>' + s.shared_login_orders + ' order' + (s.shared_login_orders === 1 ? '' : 's') + '</strong>' +
                    (hidden ? '' : ' (' + money(s.shared_login_spend) + ')') + (s.shared_login_orders === 1 ? ' in this period was' : ' in this period were') + ' placed with the shared company login before individual logins were required, so ' + (s.shared_login_orders === 1 ? 'it cannot' : 'they cannot') + ' be tied to a person.</div>';
            }
            if (s.shared_code_attempts) {
                out += '<div class="mb-3 p-3 rounded-lg bg-yellow-50 border border-yellow-200 text-sm text-yellow-900">' +
                    '<i class="fas fa-key mr-1"></i>The shared access code was tried <strong>' + s.shared_code_attempts + '</strong> time' + (s.shared_code_attempts === 1 ? '' : 's') +
                    ' and turned away. Everyone needs their own login.</div>';
            }

            var flagged = r.people.filter(function (p) { return p.flag === 'high_spend'; });
            if (flagged.length) {
                out += '<div class="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-900">' +
                    '<p class="font-semibold mb-1"><i class="fas fa-flag mr-1"></i>Worth a conversation</p>' +
                    flagged.map(function (p) {
                        return '<p><button data-person="' + esc(p.user_id || '') + '" class="font-semibold underline">' + esc(p.name) + '</button> spent ' +
                            money(p.spend) + ' across ' + p.orders + ' order' + (p.orders === 1 ? '' : 's') + ' — at least double the ' + money(s.avg_per_ordering_person) + ' average per person.</p>';
                    }).join('') +
                    '<p class="text-xs text-red-700 mt-1">' + esc(s.high_spend_rule || '') + '</p></div>';
            }

            out += '<h4 class="font-semibold text-gray-700 mb-2">By person</h4>' +
                '<div class="border rounded-lg overflow-x-auto mb-5"><table class="w-full text-sm"><thead class="bg-gray-50 border-b"><tr>' +
                th('Person', 'name') + th('Group', 'group') + th('Orders', 'orders', true) + th('Units', 'units', true) +
                (hidden ? '' : th('Spend', 'spend', true) + th('Avg order', 'avg_order', true) + th('Share', 'share', true)) +
                th('Last order', 'last_order_at') + th('Last sign-in', 'last_login') + th('Sign-ins', 'logins', true) +
                '</tr></thead><tbody>' +
                (sortedPeople().map(function (p) {
                    var badge = p.flag ? ' <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-800">HIGH SPEND</span>' : '';
                    var state = p.status === 'removed' ? ' <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-200 text-gray-600">REMOVED</span>'
                        : p.status === 'invited' ? ' <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-yellow-100 text-yellow-800">INVITED</span>'
                        : p.status === 'disabled' ? ' <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-200 text-gray-600">DISABLED</span>' : '';
                    var name = p.user_id ? '<button data-person="' + esc(p.user_id) + '" class="font-medium text-blue-800 hover:underline text-left">' + esc(p.name) + '</button>' : '<span class="font-medium">' + esc(p.name) + '</span>';
                    return '<tr class="border-b hover:bg-gray-50"><td class="px-3 py-2">' + name + state + badge +
                        '<div class="text-xs text-gray-400">' + esc(p.email || '') + (p.location ? ' · ' + esc(p.location) : '') + '</div></td>' +
                        '<td class="px-3 py-2 text-gray-600">' + esc(p.group || '—') + '</td>' +
                        '<td class="px-3 py-2 text-right">' + p.orders + '</td><td class="px-3 py-2 text-right">' + p.units + '</td>' +
                        (hidden ? '' : '<td class="px-3 py-2 text-right font-semibold">' + money(p.spend) + '</td><td class="px-3 py-2 text-right">' + (p.orders ? money(p.avg_order) : '—') + '</td><td class="px-3 py-2 text-right text-gray-500">' + (p.share === null ? '—' : p.share + '%') + '</td>') +
                        '<td class="px-3 py-2 text-gray-500 whitespace-nowrap">' + day(p.last_order_at) + '</td>' +
                        '<td class="px-3 py-2 text-gray-500 whitespace-nowrap">' + (p.last_login ? day(p.last_login) : 'Never') + '</td>' +
                        '<td class="px-3 py-2 text-right">' + p.logins + (p.failed_logins ? ' <span class="text-red-600 text-xs">(' + p.failed_logins + ' failed)</span>' : '') + '</td></tr>';
                }).join('') || '<tr><td colspan="10" class="px-3 py-6 text-center text-gray-400">No people yet.</td></tr>') +
                '</tbody></table></div>';

            out += '<h4 class="font-semibold text-gray-700 mb-2">By group</h4>' +
                '<div class="border rounded-lg overflow-x-auto"><table class="w-full text-sm"><thead class="bg-gray-50 border-b"><tr>' +
                '<th class="px-3 py-2 text-xs font-semibold text-gray-500 uppercase text-left">Group</th><th class="px-3 py-2 text-xs font-semibold text-gray-500 uppercase text-right">People</th>' +
                '<th class="px-3 py-2 text-xs font-semibold text-gray-500 uppercase text-right">Orders</th>' +
                (hidden ? '' : '<th class="px-3 py-2 text-xs font-semibold text-gray-500 uppercase text-right">Spend</th><th class="px-3 py-2 text-xs font-semibold text-gray-500 uppercase text-right">Per person</th><th class="px-3 py-2 text-xs font-semibold text-gray-500 uppercase text-right">Share</th>') +
                '</tr></thead><tbody>' +
                (r.groups.map(function (g) {
                    return '<tr class="border-b"><td class="px-3 py-2 font-medium">' + (g.name ? esc(g.name) : '<span class="text-gray-400">No group</span>') + '</td>' +
                        '<td class="px-3 py-2 text-right">' + g.members + '</td><td class="px-3 py-2 text-right">' + g.orders + '</td>' +
                        (hidden ? '' : '<td class="px-3 py-2 text-right font-semibold">' + money(g.spend) + '</td><td class="px-3 py-2 text-right">' + money(g.spend_per_member) + '</td><td class="px-3 py-2 text-right text-gray-500">' + (g.share === null ? '—' : g.share + '%') + '</td>') + '</tr>';
                }).join('') || '<tr><td colspan="6" class="px-3 py-6 text-center text-gray-400">No groups yet — add some under the Groups tab.</td></tr>') +
                '</tbody></table></div>';

            if (st.detail) out += detailView(hidden);
            return out;
        }

        function detailView(hidden) {
            var d = st.detail;
            var out = '<div data-detail class="mt-5 border rounded-xl bg-gray-50 p-4">';
            if (d.loading) return out + '<p class="text-gray-400">Loading…</p></div>';
            if (d.error) return out + '<p class="text-red-600">' + esc(d.error) + '</p></div>';
            out += '<div class="flex justify-between items-start mb-3"><div><p class="font-semibold text-gray-800">' + esc(d.user.name) + '</p><p class="text-xs text-gray-500">' + esc(d.user.email) + '</p></div>' +
                '<button data-action="close-detail" class="text-gray-400 hover:text-gray-700"><i class="fas fa-times"></i></button></div>' +
                '<div class="grid md:grid-cols-2 gap-4"><div><p class="text-xs font-semibold text-gray-500 uppercase mb-1">Orders</p>' +
                (d.orders.length ? '<table class="w-full text-sm"><tbody>' + d.orders.map(function (o) {
                    return '<tr class="border-b"><td class="py-1 pr-2 text-gray-500 whitespace-nowrap">' + day(o.created_at) + '</td><td class="py-1 pr-2 font-mono text-blue-800">' + esc(o.order_number || '') + '</td>' +
                        '<td class="py-1 pr-2 text-gray-600">' + esc(o.location || '') + (o.po_number ? ' · PO ' + esc(o.po_number) : '') + '</td>' +
                        '<td class="py-1 text-right font-semibold">' + (hidden ? o.units + ' units' : money(o.total)) + '</td></tr>';
                }).join('') + '</tbody></table>' : '<p class="text-sm text-gray-400">No orders in this period.</p>') +
                '</div><div><p class="text-xs font-semibold text-gray-500 uppercase mb-1">Sign-ins</p>' +
                (d.logins.length ? '<table class="w-full text-sm"><tbody>' + d.logins.slice(0, 30).map(function (l) {
                    var e = EVENTS[l.event] || [l.event, 'bg-gray-100 text-gray-700'];
                    return '<tr class="border-b"><td class="py-1 pr-2 text-gray-500 whitespace-nowrap">' + when(l.created_at) + '</td>' +
                        '<td class="py-1 pr-2"><span class="px-1.5 py-0.5 rounded text-xs font-semibold ' + e[1] + '">' + e[0] + '</span></td>' +
                        '<td class="py-1 text-gray-400 text-xs">' + esc(device(l.user_agent)) + '</td></tr>';
                }).join('') + '</tbody></table>' : '<p class="text-sm text-gray-400">No sign-ins in this period.</p>') +
                '</div></div></div>';
            return out;
        }

        function loginsView() {
            if (!st.logins) return '<p class="text-gray-400 text-center py-10">Loading…</p>';
            return '<p class="text-sm text-gray-500 mb-2">Every attempt to sign in, newest first (latest 300). Failed attempts are included so a shared or guessed password is easy to spot.</p>' +
                '<div class="border rounded-lg overflow-x-auto"><table class="w-full text-sm"><thead class="bg-gray-50 border-b"><tr>' +
                '<th class="px-3 py-2 text-xs font-semibold text-gray-500 uppercase text-left">When</th><th class="px-3 py-2 text-xs font-semibold text-gray-500 uppercase text-left">Who</th>' +
                '<th class="px-3 py-2 text-xs font-semibold text-gray-500 uppercase text-left">What happened</th><th class="px-3 py-2 text-xs font-semibold text-gray-500 uppercase text-left">Device</th>' +
                '<th class="px-3 py-2 text-xs font-semibold text-gray-500 uppercase text-left">Address</th></tr></thead><tbody>' +
                (st.logins.map(function (l) {
                    var e = EVENTS[l.event] || [l.event, 'bg-gray-100 text-gray-700'];
                    return '<tr class="border-b"><td class="px-3 py-2 text-gray-500 whitespace-nowrap">' + when(l.created_at) + '</td>' +
                        '<td class="px-3 py-2">' + esc(l.name || l.email || 'Unknown') + (l.name && l.email ? '<div class="text-xs text-gray-400">' + esc(l.email) + '</div>' : '') + '</td>' +
                        '<td class="px-3 py-2"><span class="px-1.5 py-0.5 rounded text-xs font-semibold ' + e[1] + '">' + e[0] + '</span></td>' +
                        '<td class="px-3 py-2 text-gray-500">' + esc(device(l.user_agent)) + '</td><td class="px-3 py-2 text-gray-400 text-xs">' + esc(l.ip || '') + '</td></tr>';
                }).join('') || '<tr><td colspan="5" class="px-3 py-6 text-center text-gray-400">No sign-ins in this period.</td></tr>') +
                '</tbody></table></div>';
        }

        function groupsView() {
            if (!st.groups) return '<p class="text-gray-400 text-center py-10">Loading…</p>';
            var users = (st.users || []).filter(function (u) { return u.status !== 'disabled' || u.group_id; });
            return '<p class="text-sm text-gray-500 mb-3">Put people into named groups — for example <em>Painters</em>, <em>Estimators</em> or <em>Managers</em> — so the activity report can be read by group.</p>' +
                '<form data-form="add-group" class="flex gap-2 mb-4"><input data-field="new-group" maxlength="80" placeholder="New group name" class="flex-1 border rounded-lg px-3 py-2 text-sm">' +
                '<button type="submit" class="bg-blue-700 hover:bg-blue-800 text-white font-semibold px-4 rounded-lg text-sm">Add group</button></form>' +
                '<div class="border rounded-lg overflow-hidden mb-6"><table class="w-full text-sm"><tbody>' +
                (st.groups.map(function (g) {
                    return '<tr class="border-b"><td class="px-3 py-2 font-medium">' + esc(g.name) + '</td><td class="px-3 py-2 text-gray-500">' + g.members + ' ' + (g.members === 1 ? 'person' : 'people') + '</td>' +
                        '<td class="px-3 py-2 text-right space-x-3"><button data-rename="' + esc(g.id) + '" data-name="' + esc(g.name) + '" class="text-gray-500 hover:text-gray-800" title="Rename"><i class="fas fa-pen"></i></button>' +
                        '<button data-delgroup="' + esc(g.id) + '" data-name="' + esc(g.name) + '" class="text-red-500 hover:text-red-700" title="Delete group"><i class="fas fa-trash"></i></button></td></tr>';
                }).join('') || '<tr><td class="px-3 py-6 text-center text-gray-400">No groups yet.</td></tr>') +
                '</tbody></table></div>' +
                '<h4 class="font-semibold text-gray-700 mb-2">Who is in which group</h4>' +
                '<div class="border rounded-lg overflow-x-auto"><table class="w-full text-sm"><thead class="bg-gray-50 border-b"><tr>' +
                '<th class="px-3 py-2 text-xs font-semibold text-gray-500 uppercase text-left">Person</th><th class="px-3 py-2 text-xs font-semibold text-gray-500 uppercase text-left">Group</th></tr></thead><tbody>' +
                (users.map(function (u) {
                    return '<tr class="border-b"><td class="px-3 py-2"><span class="font-medium">' + esc(u.name) + '</span><div class="text-xs text-gray-400">' + esc(u.email) + '</div></td>' +
                        '<td class="px-3 py-2"><select data-assign="' + esc(u.id) + '" class="border rounded-lg px-2 py-1 text-sm bg-white"><option value="">No group</option>' +
                        st.groups.map(function (g) { return '<option value="' + esc(g.id) + '"' + (u.group_id === g.id ? ' selected' : '') + '>' + esc(g.name) + '</option>'; }).join('') +
                        '</select></td></tr>';
                }).join('') || '<tr><td colspan="2" class="px-3 py-6 text-center text-gray-400">No people yet.</td></tr>') +
                '</tbody></table></div>';
        }

        function draw() {
            var body;
            if (st.moduleOff) {
                body = '<div class="p-6 text-center text-gray-500"><i class="fas fa-eye-slash text-3xl text-gray-300 mb-2"></i>' +
                    '<p class="font-semibold text-gray-700">People &amp; activity is switched off</p>' +
                    '<p class="text-sm mt-1">' + (opts.staff ? 'Turn it on under <strong>Modules</strong> for this customer. It needs Customer users on first.' : 'Ask CHC to switch it on for your account.') + '</p></div>';
                host.innerHTML = body; return;
            }
            body = tabs() + controls() +
                (st.error ? '<div class="mb-3 p-3 rounded-lg bg-red-50 text-red-700 text-sm">' + esc(st.error) + '</div>' : '') +
                (st.busy && !st.report ? '<p class="text-gray-400 text-center py-10"><i class="fas fa-spinner fa-spin"></i></p>' :
                    st.tab === 'activity' ? activityView() : st.tab === 'logins' ? loginsView() : groupsView());
            // Keep what the person was typing across a redraw.
            var typing = host.querySelector('[data-field="new-group"]');
            var typed = typing ? typing.value : '';
            host.innerHTML = body;
            if (typed) { var again = host.querySelector('[data-field="new-group"]'); if (again) again.value = typed; }
        }

        // ------------------------------------------------------------------ actions

        function csv() {
            var r = st.report; if (!r) return;
            var hidden = r.pricing_hidden;
            var head = ['Person', 'Email', 'Group', 'Shop', 'Status', 'Orders', 'Units'].concat(hidden ? [] : ['Spend', 'Average order', 'Largest order', 'Share %']).concat(['Last order', 'Last sign-in', 'Sign-ins', 'Failed sign-ins', 'Flag']);
            var rows = [head].concat(sortedPeople().map(function (p) {
                return [p.name, p.email, p.group, p.location, p.status, p.orders, p.units]
                    .concat(hidden ? [] : [p.spend, p.avg_order, p.largest_order, p.share])
                    .concat([p.last_order_at || '', p.last_login || '', p.logins, p.failed_logins, p.flag ? 'High spend' : '']);
            }));
            var blob = new Blob([rows.map(function (row) { return row.map(csvCell).join(','); }).join('\n')], { type: 'text/csv;charset=utf-8;' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'people-activity-' + st.period + '.csv';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
        }

        async function changeGroup(method, path, body, okMsg) {
            try {
                var resp = await opts.req(path, { method: method, body: body ? JSON.stringify(body) : undefined });
                var data = await json(resp);
                if (!resp.ok) { alert(data.error || 'That did not work.'); return false; }
                return true;
            } catch (e) { alert('Connection error. Please try again.'); return false; }
        }

        host.addEventListener('click', async function (e) {
            var t = e.target.closest('button'); if (!t || !host.contains(t)) return;
            if (t.dataset.tab) {
                st.tab = t.dataset.tab; st.error = null; draw();
                if (st.tab === 'logins') loadLogins();
                if (st.tab === 'groups') loadGroups();
                if (st.tab === 'activity' && !st.report) loadActivity();
                return;
            }
            if (t.dataset.sort) {
                var k = t.dataset.sort;
                st.sort = { key: k, dir: st.sort.key === k ? -st.sort.dir : (['name', 'group', 'last_order_at', 'last_login'].indexOf(k) >= 0 ? 1 : -1) };
                draw(); return;
            }
            if (t.dataset.person) { openPerson(t.dataset.person); return; }
            if (t.dataset.action === 'refresh') { api.reload(); return; }
            if (t.dataset.action === 'csv') { csv(); return; }
            if (t.dataset.action === 'close-detail') { st.detail = null; draw(); return; }
            if (t.dataset.rename) {
                var name = window.prompt('Rename group', t.dataset.name);
                if (name && name.trim() && name.trim() !== t.dataset.name && await changeGroup('PUT', '/groups/' + t.dataset.rename, { name: name.trim() })) { await loadGroups(); st.report = null; }
                return;
            }
            if (t.dataset.delgroup) {
                if (!window.confirm('Delete the group "' + t.dataset.name + '"? Its people stay, just without a group. Past orders keep the group they were placed under.')) return;
                if (await changeGroup('DELETE', '/groups/' + t.dataset.delgroup)) { st.group = ''; st.report = null; await loadGroups(); }
            }
        });

        host.addEventListener('change', async function (e) {
            var t = e.target;
            if (t.dataset.field === 'period') { st.period = t.value; st.detail = null; st.logins = null; api.reload(); return; }
            if (t.dataset.field === 'location') { st.location = t.value; st.detail = null; loadActivity(); return; }
            if (t.dataset.field === 'group') { st.group = t.value; st.detail = null; loadActivity(); return; }
            if (t.dataset.assign) {
                var uid = t.dataset.assign;
                try {
                    var resp = await opts.usersReq('/' + encodeURIComponent(uid), { method: 'PUT', body: JSON.stringify({ group_id: t.value || null }) });
                    var data = await json(resp);
                    if (!resp.ok) { alert(data.error || 'Could not change that person’s group.'); await loadGroups(); return; }
                    st.report = null;
                    await loadGroups();
                } catch (err) { alert('Connection error. Please try again.'); }
            }
        });

        host.addEventListener('submit', async function (e) {
            if (e.target.dataset.form !== 'add-group') return;
            e.preventDefault();
            var input = host.querySelector('[data-field="new-group"]');
            var name = input && input.value.trim(); if (!name) return;
            if (await changeGroup('POST', '/groups', { name: name })) { input.value = ''; st.report = null; await loadGroups(); }
        });

        var api = {
            reload: function () {
                if (st.tab === 'logins') return loadLogins();
                if (st.tab === 'groups') return loadGroups();
                return loadActivity();
            }
        };

        (async function init() {
            try { st.locations = (opts.loadLocations ? await opts.loadLocations() : []) || []; } catch (e) { st.locations = []; }
            draw();
            await loadGroups();     // also tells us at once if the module is off, and fills the group filter
            if (!st.moduleOff) await loadActivity();
        })();

        return api;
    }

    var exported = { mount: mount, periodRange: periodRange, device: device, money: money };
    if (typeof window !== 'undefined') window.PeopleActivity = exported;
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})();
