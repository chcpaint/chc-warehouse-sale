/**
 * public/new-look.js -- refinishAI new look, phase 1.
 *
 * Switched on per company by CHC (the "New look" module). With it off this
 * file does nothing at all: no class is added, no menu changes, no extra
 * requests. That is what keeps every other shop, Assured included, exactly as
 * it is today.
 *
 * With it on:
 *   - body gets class "nl", which turns on public/new-look.css;
 *   - the slide-out menu becomes a permanent dark menu on desktop, with the
 *     refinishAI logo at the top;
 *   - a "Today" screen is added first in the menu and opens after sign-in. It
 *     shows what needs a person now, read from the same endpoints the other
 *     screens already use. It changes nothing.
 *
 * Loaded after the store's own script, so it can use that script's top-level
 * names (state, NAV, showTab, buildDrawer, apiFetch, escapeHtml).
 */
(function () {
    'use strict';

    const NL = {};
    let observer = null;

    function settingsOf(company) {
        return (company && company.settings && typeof company.settings === 'object') ? company.settings : {};
    }
    function moduleOn(company, name) {
        const m = settingsOf(company)[name];
        return !!(m && m.enabled === true);
    }
    function esc(v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function qty(n) {
        const x = Number(n || 0);
        return Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/\.?0+$/, '');
    }
    function money(n) {
        return '$' + Number(n || 0).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function plural(n, one, many) { return n === 1 ? one : many; }

    NL.isOn = function () { return document.body.classList.contains('nl'); };

    /**
     * Called by the store when the app opens. Returns true if the new look is on.
     */
    NL.apply = function (company) {
        const on = moduleOn(company, 'new_look');
        document.body.classList.toggle('nl', on);
        if (!on) return false;

        // The refinishAI logo, top left of the menu.
        const drawer = document.getElementById('drawer');
        if (drawer && !drawer.querySelector('.nl-brand')) {
            const brand = document.createElement('div');
            brand.className = 'nl-brand';
            brand.innerHTML = '<div><img src="/assets/refinishai-lockup.png" alt="refinishAI" width="196" height="55"></div>';
            drawer.insertBefore(brand, drawer.firstChild);
        }

        // "Today" first in the menu.
        try {
            if (typeof NAV !== 'undefined' && !NAV.some(g => g.items.some(i => i.tab === 'today'))) {
                NAV.unshift({ group: 'Today', items: [{ tab: 'today', label: 'Today', icon: 'fa-house' }] });
            }
        } catch (_) { /* the menu still works without it */ }

        // On a desktop the menu is a permanent sidebar, not a pop-up dialog.
        const desktop = window.matchMedia('(min-width: 1024px)');
        const syncRole = () => {
            if (!drawer) return;
            if (desktop.matches) { drawer.setAttribute('role', 'navigation'); drawer.removeAttribute('aria-modal'); }
            else { drawer.setAttribute('role', 'dialog'); drawer.setAttribute('aria-modal', 'true'); }
        };
        syncRole();
        if (desktop.addEventListener) desktop.addEventListener('change', syncRole);

        fillMenuHeader();
        rebuildMenu();

        // Inventory, kits and billing reveal their menu entries after their own
        // checks finish. Rebuild the permanent menu when they do.
        if (!observer && window.MutationObserver) {
            observer = new MutationObserver(rebuildMenu);
            ['nav-inventory', 'nav-kitsub', 'nav-shopsafe', 'nav-billing'].forEach(id => {
                const el = document.getElementById(id);
                if (el) observer.observe(el, { attributes: true, attributeFilter: ['class'] });
            });
        }

        if (typeof showTab === 'function') showTab('today');
        syncCurrent();
        return true;
    };

    function fillMenuHeader() {
        const c = document.getElementById('drawer-company');
        const l = document.getElementById('drawer-location');
        if (c && typeof state !== 'undefined' && state.company) c.textContent = state.company.name || '';
        if (l && typeof state !== 'undefined' && state.location) l.textContent = state.location.name || '';
    }
    function rebuildMenu() {
        if (!NL.isOn() || typeof buildDrawer !== 'function') return;
        buildDrawer();
        syncCurrent();
    }
    // The store works out "current" from its old tab row, which has no Today
    // button. Mark whichever screen is actually showing.
    function syncCurrent() {
        const shown = Array.from(document.querySelectorAll('main section[id^="tab-"]'))
            .find(el => !el.classList.contains('hidden'));
        const tab = shown ? shown.id.slice(4) : null;
        if (!tab) return;
        document.querySelectorAll('[data-drawer-tab]').forEach(el => {
            if (el.dataset.drawerTab === tab) el.setAttribute('aria-current', 'page');
            else el.removeAttribute('aria-current');
        });
    }

    // Clicks inside Today use data attributes, not inline handlers.
    document.addEventListener('click', (e) => {
        const btn = e.target.closest && e.target.closest('[data-nl-tab]');
        if (!btn || !NL.isOn()) return;
        e.preventDefault();
        if (typeof showTab === 'function') showTab(btn.getAttribute('data-nl-tab'));
    });

    /** Render the Today screen. Read-only. */
    NL.renderToday = async function () {
        const host = document.getElementById('tab-today');
        if (!host || typeof state === 'undefined' || !state.company) return;
        const company = state.company;
        const slug = state.slug;
        const loc = state.location || {};
        const invOn = moduleOn(company, 'inventory') && !!loc.id;
        const today = new Date().toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' });

        host.innerHTML = `
            <div class="nl-today">
                <div class="nl-head"><div><p class="nl-kicker">${esc(today)} · ${esc(company.name)}${loc.name ? ' · ' + esc(loc.name) : ''}</p>
                <h1>Loading today…</h1></div></div>
                <div class="nl-cards"><div class="nl-skel"></div><div class="nl-skel"></div><div class="nl-skel"></div></div>
            </div>`;

        const get = async (path) => {
            try {
                const r = await apiFetch(path);
                return r.ok ? await r.json() : null;
            } catch (_) { return null; }
        };
        const L = encodeURIComponent(loc.id || '');
        const [ordersRes, summaryRes, outRes, lowRes] = await Promise.all([
            get(`/store/${slug}/orders`),
            invOn ? get(`/store/${slug}/inventory/summary?location_id=${L}`) : null,
            invOn ? get(`/store/${slug}/inventory/levels?location_id=${L}&status=out&limit=8`) : null,
            invOn ? get(`/store/${slug}/inventory/levels?location_id=${L}&status=low&limit=8`) : null
        ]);
        // The user may have moved on while this loaded.
        if (host.classList.contains('hidden')) return;

        const orders = (ordersRes && ordersRes.orders) || [];
        const mine = orders.filter(o => !loc.id || !o.location_id || o.location_id === loc.id);
        const onTheWay = mine.filter(o => o.status === 'out_on_delivery');
        const inProgress = mine.filter(o => o.status === 'pending' || o.status === 'processing');
        const cartLines = Array.isArray(state.cart) ? state.cart.length : 0;
        const s = summaryRes && summaryRes.summary;
        const pendingReorders = summaryRes ? Number(summaryRes.pending_replenishment || 0) : 0;
        const belowMin = s ? Number(s.low || 0) + Number(s.out || 0) : 0;

        const cards = [];
        if (invOn && s) {
            cards.push({
                chip: belowMin ? ['orange', 'Below minimum'] : ['green', 'Stock'],
                num: belowMin ? `${belowMin} ${plural(belowMin, 'item', 'items')}` : 'All good',
                text: belowMin
                    ? `${Number(s.out || 0)} out and ${Number(s.low || 0)} low at this shop.`
                    : `Everything tracked here is at or above its minimum.`,
                link: ['inventory', 'Open stock'], needs: belowMin > 0
            });
            cards.push({
                chip: pendingReorders ? ['grey', 'Waiting on you'] : ['grey', 'Reorders'],
                num: pendingReorders ? `${pendingReorders} ${plural(pendingReorders, 'reorder', 'reorders')}` : 'None waiting',
                text: pendingReorders
                    ? 'Drafted from the shelf. Check it, then approve or change it.'
                    : 'Drafts appear here when items drop below their minimum.',
                link: ['inventory', pendingReorders ? 'Review and approve' : 'Open stock'], needs: pendingReorders > 0
            });
        }
        cards.push({
            chip: ['blue', 'Out for delivery'],
            num: `${onTheWay.length} ${plural(onTheWay.length, 'order', 'orders')}`,
            text: onTheWay.length
                ? (invOn ? 'Scan them in as they arrive; damaged or short lines go straight to CHC.' : 'On the truck now.')
                : 'Nothing on the road right now.',
            link: [invOn ? 'inventory' : 'orders', invOn ? 'Receive' : 'Track orders'], needs: onTheWay.length > 0
        });
        cards.push({
            chip: ['amber', 'In progress'],
            num: `${inProgress.length} ${plural(inProgress.length, 'order', 'orders')}`,
            text: inProgress.length ? 'With CHC now, being picked or waiting to start.' : 'No orders waiting at CHC.',
            link: ['orders', 'Order history'], needs: false
        });
        if (cartLines) {
            cards.push({
                chip: ['blue', 'Cart'],
                num: `${cartLines} ${plural(cartLines, 'line', 'lines')}`,
                text: 'Shared with everyone signed in to this account.',
                link: ['cart', 'Open cart'], needs: true
            });
        }

        const needing = cards.filter(c => c.needs).length;
        const headline = needing === 0 ? 'Nothing needs you right now'
            : needing === 1 ? 'One thing needs you today' : `${['', '', 'Two', 'Three', 'Four', 'Five'][needing] || needing} things need you today`;

        const cardHtml = cards.map(c => `
            <article class="nl-card">
                <span class="nl-chip ${c.chip[0]}">${esc(c.chip[1])}</span>
                <div class="nl-num">${esc(c.num)}</div>
                <p>${esc(c.text)}</p>
                <button type="button" class="nl-link" data-nl-tab="${esc(c.link[0])}">${esc(c.link[1])}</button>
            </article>`).join('');

        let lowPanel = '';
        if (invOn) {
            const rows = [...((outRes && outRes.levels) || []), ...((lowRes && lowRes.levels) || [])].slice(0, 8);
            const body = rows.length ? `
                <div class="nl-scroll"><table class="nl-table">
                    <thead><tr><th>Item</th><th class="num">On hand</th><th class="num">Min / max</th><th class="num">Suggested</th><th>Status</th></tr></thead>
                    <tbody>${rows.map(r => `
                        <tr>
                            <td><div class="nl-item">${esc(r.product_name)}</div><div class="nl-sku">${esc(r.sku)}</div></td>
                            <td class="num"><strong${Number(r.on_hand) <= 0 ? ' style="color:var(--nl-red)"' : ''}>${esc(qty(r.on_hand))}</strong></td>
                            <td class="num">${r.min_point == null ? '—' : esc(qty(r.min_point))} / ${r.max_point == null ? '—' : esc(qty(r.max_point))}</td>
                            <td class="num">${r.suggested_order_qty ? esc(qty(r.suggested_order_qty)) : '—'}</td>
                            <td><span class="nl-chip ${r.stock_status === 'out' ? 'red' : 'orange'}">${r.stock_status === 'out' ? 'Out' : 'Low'}</span></td>
                        </tr>`).join('')}</tbody>
                </table></div>` : `<div class="nl-empty">Nothing is below its minimum at this shop.</div>`;
            lowPanel = `
                <section class="nl-panel wide" aria-labelledby="nl-low-h">
                    <div class="nl-panel-head"><h2 id="nl-low-h">Running low</h2><button type="button" class="nl-link" data-nl-tab="inventory">All stock</button></div>
                    ${body}
                    <div class="nl-panel-foot"><span>Suggested quantities fill each item back up to its maximum.</span>
                    ${pendingReorders ? `<button type="button" class="nl-btn primary" data-nl-tab="inventory">Open the draft reorder</button>` : ''}</div>
                </section>`;
        }

        const recent = mine.slice(0, 5);
        const ordersPanel = `
            <section class="nl-panel ${invOn ? 'narrow' : 'wide'}" aria-labelledby="nl-ord-h">
                <div class="nl-panel-head"><h2 id="nl-ord-h">Recent orders</h2><button type="button" class="nl-link" data-nl-tab="orders">All orders</button></div>
                ${recent.length ? `<ul class="nl-list">${recent.map(o => `
                    <li><div><div class="nl-item">#${esc(o.order_number)}</div>
                        <div class="nl-sku">${esc(new Date(o.created_at).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }))}${o.contact_name ? ' · ' + esc(o.contact_name) : ''}</div></div>
                        <div style="text-align:right"><div>${o.pricing_hidden === true ? '' : esc(money(o.total))}</div>
                        <span class="nl-chip ${o.status === 'closed' ? 'green' : o.status === 'out_on_delivery' ? 'blue' : o.status === 'cancelled' ? 'red' : 'amber'}">${esc(o.status_label || o.status)}</span></div></li>`).join('')}</ul>`
                : `<div class="nl-empty">No orders yet from this shop.</div>`}
            </section>`;

        host.innerHTML = `
            <div class="nl-today">
                <div class="nl-head">
                    <div><p class="nl-kicker">${esc(today)} · ${esc(company.name)}${loc.name ? ' · ' + esc(loc.name) : ''}</p><h1>${esc(headline)}</h1></div>
                    <div class="nl-actions">
                        ${invOn ? '<button type="button" class="nl-btn" data-nl-tab="inventory">Scan or count stock</button>' : ''}
                        <button type="button" class="nl-btn primary" data-nl-tab="products">New order</button>
                    </div>
                </div>
                <section class="nl-cards" aria-label="Needs attention">${cardHtml}</section>
                <div class="nl-cols">${lowPanel}${ordersPanel}</div>
            </div>`;
    };

    window.NL = NL;
})();
