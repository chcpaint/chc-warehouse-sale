/**
 * utils/brand-report-data.js
 *
 * Loads orders, builds and stores the monthly brand snapshots, and assembles
 * what a download needs. The arithmetic lives in utils/brand-sales-report.js;
 * this file only reads and writes.
 *
 * Only finished months are ever stored. The month in progress is built live
 * each time it is asked for and labelled "month to date", so a snapshot never
 * has to be corrected for sales that had not happened yet.
 */

const { supabaseAdmin } = require('./supabase');
const R = require('./brand-sales-report');

const PAGE = 1000;

async function readAll(build) {
    const out = [];
    for (let from = 0; ; from += PAGE) {
        const { data, error } = await build().range(from, from + PAGE - 1);
        if (error) throw error;
        out.push(...(data || []));
        if (!data || data.length < PAGE) break;
    }
    return out;
}

/** The customer's shipped orders that could have a shipment on or after `sinceDate`. */
async function loadShippedOrders(companyId, sinceDate) {
    // A shipment is recorded at or before the order's last update, so an order
    // last touched before the window began cannot have shipped inside it. A day
    // of slack covers the Toronto/UTC boundary.
    const since = new Date(new Date(`${sinceDate}T00:00:00Z`).getTime() - 24 * 3600 * 1000).toISOString();
    return readAll(() => supabaseAdmin.from('orders')
        .select('id, order_number, status, location, items, status_history, created_at, updated_at, closed_at')
        .eq('company_id', companyId)
        .in('status', R.SHIPPED_STATUSES)
        .gte('updated_at', since));
}

/** Brand and category for lines that did not freeze them when they were ordered. */
async function loadItemInfo(orders) {
    const ids = new Set();
    for (const o of orders) for (const l of Array.isArray(o.items) ? o.items : []) {
        if (l && l.product_id && !(l.brand && l.category)) ids.add(l.product_id);
    }
    const map = new Map();
    const list = [...ids];
    for (let i = 0; i < list.length; i += 200) {
        const { data, error } = await supabaseAdmin.from('products').select('id, brand, category').in('id', list.slice(i, i + 200));
        if (error) throw error;
        for (const p of data || []) map.set(p.id, { brand: p.brand || '', category: p.category || '' });
    }
    return map;
}

function toRow({ companyId, brand, period, snapshot, source, adminId }) {
    return {
        company_id: companyId, brand, period, basis: 'shipped', source,
        generated_at: new Date().toISOString(), generated_by: adminId || null,
        order_count: snapshot.totals.orders, total_qty: snapshot.totals.qty, total_amount: snapshot.totals.amount,
        data: snapshot
    };
}

/**
 * Stored snapshots for the given months, as { period: snapshot }.
 * Any finished month that is missing (or every one, with force) is built from
 * one pass over the orders and stored. `current` months are never stored.
 */
async function ensureSnapshots({ companyId, brand, periods, source = 'backfill', adminId = null, force = false, now = new Date() }) {
    const cur = R.currentPeriod(now);
    const finished = periods.filter(p => p < cur);

    const { data: stored, error } = await supabaseAdmin.from('monthly_brand_reports')
        .select('period, data').eq('company_id', companyId).eq('brand', brand).in('period', finished);
    if (error) throw error;
    const out = {};
    for (const r of stored || []) out[r.period] = r.data;

    const need = finished.filter(p => force || !out[p]);
    if (need.length) {
        const orders = await loadShippedOrders(companyId, `${need[0]}-01`);
        const info = await loadItemInfo(orders);
        for (const p of need) {
            const snap = R.buildMonth({ orders, itemInfo: info, brand, period: p });
            const { error: wErr } = await supabaseAdmin.from('monthly_brand_reports')
                .upsert(toRow({ companyId, brand, period: p, snapshot: snap, source, adminId }), { onConflict: 'company_id,brand,period' });
            if (wErr) throw wErr;
            out[p] = snap;
        }
    }

    // The month in progress, live.
    if (periods.includes(cur)) {
        const orders = await loadShippedOrders(companyId, `${cur}-01`);
        const info = await loadItemInfo(orders);
        out[cur] = R.buildMonth({ orders, itemInfo: info, brand, period: cur });
    }
    return out;
}

/**
 * Everything a download needs for one month: the month, and the year to date
 * through it. Asking for the month in progress gives month to date.
 */
async function buildReport({ companyId, companyName, brand, period, adminId = null, now = new Date() }) {
    const periods = R.monthsOfYearThrough(period);
    const snaps = await ensureSnapshots({ companyId, brand, periods, adminId, now });
    const month = snaps[period];
    const ytd = R.rollUp(snaps, { periods, brand });
    const partial = period >= R.currentPeriod(now);

    const { data: meta } = partial ? { data: null } : await supabaseAdmin.from('monthly_brand_reports')
        .select('generated_at, source').eq('company_id', companyId).eq('brand', brand).eq('period', period).maybeSingle();

    return {
        company: companyName, brand, month, ytd, partial,
        as_of: R.torontoParts(now).date,
        generated_at: partial ? now.toISOString() : (meta && meta.generated_at) || now.toISOString(),
        source: meta && meta.source || null
    };
}

/** The list the admin screen shows: every stored month, plus the one in progress. */
async function listReports({ companyId, brand, now = new Date() }) {
    const { data, error } = await supabaseAdmin.from('monthly_brand_reports')
        .select('period, generated_at, source, order_count, total_qty, total_amount')
        .eq('company_id', companyId).eq('brand', brand).order('period', { ascending: false });
    if (error) throw error;
    return (data || []).map(r => ({
        period: r.period, label: R.periodLabel(r.period), generated_at: r.generated_at, source: r.source,
        orders: r.order_count, qty: Number(r.total_qty), amount: Number(r.total_amount)
    }));
}

/**
 * Subscriptions whose last finished month (or any earlier month of its year) is
 * not stored yet. Cheap: two small reads, no orders touched.
 */
async function findPending(prev) {
    const { data: subs, error } = await supabaseAdmin.from('brand_report_subscriptions')
        .select('company_id, brand').eq('is_enabled', true);
    if (error) {
        // Before migration 056 is applied there is nothing to do, and that is not an error.
        if (/brand_report_subscriptions|does not exist|schema cache/i.test(error.message || '')) return { total: 0, pending: [], periods: [] };
        throw error;
    }
    const periods = R.monthsOfYearThrough(prev);
    const pending = [];
    for (const s of subs || []) {
        const { data: have, error: hErr } = await supabaseAdmin.from('monthly_brand_reports')
            .select('period').eq('company_id', s.company_id).eq('brand', s.brand).in('period', periods);
        if (hErr) throw hErr;
        const had = new Set((have || []).map(r => r.period));
        if (!periods.every(p => had.has(p))) pending.push(s);
    }
    return { total: (subs || []).length, pending, periods };
}

/**
 * The scheduled run: for every switched-on subscription, make sure last month
 * (and the rest of its year) is stored. Idempotent, so a retry or a second
 * instance that slips past the claim does no harm.
 */
async function runMonthlyBrandReports({ now = new Date() } = {}) {
    const prev = R.previousPeriod(now);
    const { total, pending, periods } = await findPending(prev);
    const result = { subscriptions: total, generated: 0, already: total - pending.length, failed: 0, period: prev };

    for (const s of pending) {
        try {
            await ensureSnapshots({ companyId: s.company_id, brand: s.brand, periods, source: 'scheduled', now });
            result.generated += 1;
        } catch (err) {
            result.failed += 1;
            console.error(`Brand report failed for ${s.company_id}/${s.brand}:`, err.message);
        }
    }
    return result;
}

module.exports = { findPending, loadShippedOrders, loadItemInfo, ensureSnapshots, buildReport, listReports, runMonthlyBrandReports };
