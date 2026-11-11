/**
 * utils/insights-data.js
 *
 * Builds the one snapshot of a shop's numbers that Insights sends to the AI.
 *
 * What goes in is deliberately narrow and the same every time:
 *   - totals, trends and top lists for the last 90 days against the 90 before;
 *   - product names, part numbers, categories, brands and shop (location) names;
 *   - stock counts and value when the shop uses Inventory;
 *   - insurance-kit totals when the shop uses kit submissions.
 *
 * What never goes in: people's names, emails, phone numbers, addresses, PO
 * numbers, repair-order or claim numbers, VINs, notes, or anything typed
 * free-form. Dollar amounts are left out entirely when the shop has pricing
 * hidden. The person sees this exact snapshot before and after the call.
 *
 * The summarise* functions are pure (tested without a database);
 * loadInsightsSnapshot reads the rows and hands them over.
 */
const DAY = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 90;

const r2 = n => Math.round(Number(n || 0) * 100) / 100;
const r1 = n => Math.round(Number(n || 0) * 10) / 10;
const text = (v, max = 80) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const pct = (cur, prev) => (prev > 0 ? r1(((cur - prev) / prev) * 100) : null);

function lineSpend(it) {
    if (it.subtotal != null && Number.isFinite(Number(it.subtotal))) return Number(it.subtotal);
    return Number(it.quantity || 0) * Number(it.unit_price || 0);
}

/**
 * @param {Array} orders   orders rows with items (jsonb array), status, total, created_at, location_id, location
 * @param {Object} opts    { now, hidePrices, productMeta: Map(product_id -> {category, brand}) }
 */
function summarizeOrders(orders, { now = Date.now(), hidePrices = false, productMeta = new Map() } = {}) {
    const curStart = now - WINDOW_DAYS * DAY;
    const prevStart = now - 2 * WINDOW_DAYS * DAY;
    const counted = (orders || []).filter(o => o && o.status !== 'cancelled');
    const inCur = counted.filter(o => Date.parse(o.created_at) >= curStart);
    const inPrev = counted.filter(o => { const t = Date.parse(o.created_at); return t >= prevStart && t < curStart; });

    const spendOf = list => r2(list.reduce((s, o) => s + Number(o.total || 0), 0));
    const cats = new Map();
    const items = new Map();
    const promo = { lines: 0, spend: 0 };
    const addLines = (list, key) => {
        for (const o of list) {
            for (const it of Array.isArray(o.items) ? o.items : []) {
                const meta = productMeta.get(it.product_id) || {};
                const cat = text(it.category || meta.category || it.brand || meta.brand || 'Uncategorised', 60);
                const c = cats.get(cat) || { name: cat, cur: 0, prev: 0 };
                c[key] += lineSpend(it);
                cats.set(cat, c);
                if (key === 'cur') {
                    const k = it.sku || it.product_id || it.name;
                    const row = items.get(k) || { sku: text(it.sku, 40), name: text(it.name, 80), units: 0, spend: 0, orders: 0 };
                    row.units += Number(it.quantity || 0);
                    row.spend += lineSpend(it);
                    row.orders += 1;
                    items.set(k, row);
                    if (it.was_promo) { promo.lines++; promo.spend += lineSpend(it); }
                }
            }
        }
    };
    addLines(inCur, 'cur');
    addLines(inPrev, 'prev');

    const monthly = new Map();
    for (const o of counted.filter(o => Date.parse(o.created_at) >= prevStart)) {
        const m = new Date(o.created_at).toISOString().slice(0, 7);
        const e = monthly.get(m) || { month: m, orders: 0, spend: 0 };
        e.orders++; e.spend += Number(o.total || 0);
        monthly.set(m, e);
    }

    const locs = new Map();
    for (const o of inCur) {
        const k = o.location_id || 'none';
        const e = locs.get(k) || { shop: text(o.location || 'Unassigned', 60), orders: 0, spend: 0 };
        e.orders++; e.spend += Number(o.total || 0);
        locs.set(k, e);
    }

    const days = inCur.map(o => Date.parse(o.created_at)).sort((a, b) => a - b);
    const gaps = days.slice(1).map((t, i) => (t - days[i]) / DAY);
    const lastOrderDaysAgo = days.length ? r1((now - days[days.length - 1]) / DAY) : null;

    const out = {
        window: `last ${WINDOW_DAYS} days compared with the ${WINDOW_DAYS} days before`,
        orders: { current: inCur.length, previous: inPrev.length, change_pct: pct(inCur.length, inPrev.length) },
        days_since_last_order: lastOrderDaysAgo,
        average_days_between_orders: gaps.length ? r1(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null,
        partial_shipments: inCur.filter(o => o.is_partial_shipment).length,
        open_backorders: inCur.filter(o => Array.isArray(o.backorder_items) && o.backorder_items.length && o.status !== 'closed').length,
        cancelled: (orders || []).filter(o => o && o.status === 'cancelled' && Date.parse(o.created_at) >= curStart).length,
        top_items: [...items.values()].sort((a, b) => b.spend - a.spend || b.units - a.units).slice(0, 12)
            .map(i => hidePrices ? { sku: i.sku, name: i.name, units: r1(i.units), times_ordered: i.orders }
                : { sku: i.sku, name: i.name, units: r1(i.units), times_ordered: i.orders, spend: r2(i.spend) }),
        by_category: [...cats.values()].sort((a, b) => b.cur - a.cur).slice(0, 10)
            .map(c => hidePrices ? { category: c.name, change_pct: pct(c.cur, c.prev) }
                : { category: c.name, spend_current: r2(c.cur), spend_previous: r2(c.prev), change_pct: pct(c.cur, c.prev) }),
        by_month: [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month))
            .map(m => hidePrices ? { month: m.month, orders: m.orders } : { month: m.month, orders: m.orders, spend: r2(m.spend) })
    };
    if (locs.size > 1) {
        out.by_shop = [...locs.values()].sort((a, b) => b.orders - a.orders)
            .map(l => hidePrices ? { shop: l.shop, orders: l.orders } : { shop: l.shop, orders: l.orders, spend: r2(l.spend) });
    }
    if (!hidePrices) {
        const cur = spendOf(inCur), prev = spendOf(inPrev);
        out.spend = { current: cur, previous: prev, change_pct: pct(cur, prev), average_order: inCur.length ? r2(cur / inCur.length) : null };
        out.promotion_lines = { lines: promo.lines, spend: r2(promo.spend) };
    }
    return out;
}

/**
 * @param {Array} levels    inventory_status rows
 * @param {Array} consumes  stock_movements rows (movement_type consume) for the last 90 days
 */
function summarizeInventory(levels, consumes, { now = Date.now(), hidePrices = false } = {}) {
    const rows = (levels || []).filter(r => r && r.is_tracked !== false);
    const name = new Map(rows.map(r => [r.product_id, { sku: text(r.sku, 40), name: text(r.product_name, 80) }]));
    const used = new Map();
    for (const m of consumes || []) {
        const e = used.get(m.product_id) || 0;
        used.set(m.product_id, e + Math.abs(Number(m.qty_change || 0)));
    }
    const staleCount = rows.filter(r => !r.last_counted_at || (now - Date.parse(r.last_counted_at)) > 30 * DAY).length;
    const idle = rows.filter(r => Number(r.on_hand || 0) > 0 && !used.has(r.product_id)
        && (!r.last_movement_at || (now - Date.parse(r.last_movement_at)) > 90 * DAY));
    const noMin = rows.filter(r => r.min_point == null).length;
    const out = {
        items_tracked: rows.length,
        out_of_stock: rows.filter(r => r.stock_status === 'out').length,
        below_minimum: rows.filter(r => r.stock_status === 'low').length,
        without_a_minimum: noMin,
        not_counted_in_30_days: staleCount,
        no_use_in_90_days_but_on_shelf: idle.length,
        most_used_last_90_days: [...used.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
            .map(([pid, units]) => ({ ...(name.get(pid) || { sku: '', name: 'Unknown item' }), units_used: r1(units) })),
        currently_out: rows.filter(r => r.stock_status === 'out').slice(0, 10).map(r => ({ sku: text(r.sku, 40), name: text(r.product_name, 80) }))
    };
    if (!hidePrices) {
        out.stock_value = r2(rows.reduce((s, r) => s + (r.price_on_request ? 0 : Number(r.line_value ?? (Number(r.on_hand || 0) * Number(r.price || 0)))), 0));
        out.value_sitting_unused = r2(idle.reduce((s, r) => s + (r.price_on_request ? 0 : Number(r.on_hand || 0) * Number(r.price || 0)), 0));
    }
    return out;
}

function summarizeKits(subs, { now = Date.now(), hidePrices = false } = {}) {
    const curStart = now - WINDOW_DAYS * DAY;
    const live = (subs || []).filter(s => s && s.status !== 'void' && Date.parse(s.created_at) >= curStart);
    const byKit = new Map();
    for (const s of live) byKit.set(text(s.kit_name, 80), (byKit.get(text(s.kit_name, 80)) || 0) + 1);
    const out = {
        submissions_last_90_days: live.length,
        unpaid: live.filter(s => s.status === 'issued').length,
        most_used_kits: [...byKit.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([kit, times]) => ({ kit, times }))
    };
    if (!hidePrices) out.total_billed = r2(live.reduce((s, x) => s + Number(x.total_amount || 0), 0));
    return out;
}

/**
 * Read everything Insights needs for one company (optionally one location).
 * Read-only.
 */
async function loadInsightsSnapshot(supabase, { companyId, locationId = null, locationName = null, modules = {}, hidePrices = false, now = Date.now() }) {
    const since = new Date(now - 2 * WINDOW_DAYS * DAY).toISOString();
    let oq = supabase.from('orders')
        .select('id, status, total, created_at, items, is_partial_shipment, backorder_items, location_id, location')
        .eq('company_id', companyId).gte('created_at', since).order('created_at', { ascending: false }).limit(5000);
    if (locationId) oq = oq.eq('location_id', locationId);
    const { data: orders, error: oErr } = await oq;
    if (oErr) throw oErr;

    const ids = [...new Set((orders || []).flatMap(o => (Array.isArray(o.items) ? o.items : []).map(i => i.product_id)).filter(Boolean))];
    const productMeta = new Map();
    for (let i = 0; i < ids.length; i += 200) {
        const { data: prods } = await supabase.from('products').select('id, category, brand').eq('company_id', companyId).in('id', ids.slice(i, i + 200));
        for (const p of prods || []) productMeta.set(p.id, { category: p.category, brand: p.brand });
    }

    const snapshot = {
        scope: locationId ? `one shop: ${text(locationName || 'this shop', 60)}` : 'all shops in this account',
        prices_shown: !hidePrices,
        ordering: summarizeOrders(orders || [], { now, hidePrices, productMeta }),
        inventory: null,
        insurance_kits: null
    };

    if (modules.inventory) {
        let lq = supabase.from('inventory_status')
            .select('product_id, sku, product_name, on_hand, min_point, max_point, stock_status, is_tracked, last_counted_at, last_movement_at, price, price_on_request, line_value')
            .eq('company_id', companyId).limit(5000);
        if (locationId) lq = lq.eq('location_id', locationId);
        const { data: levels } = await lq;
        let mq = supabase.from('stock_movements').select('product_id, qty_change')
            .eq('company_id', companyId).eq('movement_type', 'consume')
            .gte('created_at', new Date(now - WINDOW_DAYS * DAY).toISOString()).limit(20000);
        if (locationId) mq = mq.eq('location_id', locationId);
        const { data: consumes } = await mq;
        snapshot.inventory = summarizeInventory(levels || [], consumes || [], { now, hidePrices });
    }
    if (modules.kit_submissions) {
        let kq = supabase.from('kit_submissions').select('kit_name, status, total_amount, created_at')
            .eq('company_id', companyId).gte('created_at', since).limit(5000);
        if (locationId) kq = kq.eq('location_id', locationId);
        const { data: subs } = await kq;
        snapshot.insurance_kits = summarizeKits(subs || [], { now, hidePrices });
    }
    return snapshot;
}

module.exports = { summarizeOrders, summarizeInventory, summarizeKits, loadInsightsSnapshot, WINDOW_DAYS };
