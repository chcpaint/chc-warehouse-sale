/**
 * utils/rebates.js
 *
 * Rebates a company earns on what it buys through the console.
 *
 * A rebate rule is a percent of what the company actually paid for goods, taken
 * after any product discount and before tax, delivery fees and fuel surcharges.
 * It can cover everything the company buys, or only chosen categories and brands.
 * Each rule has its own pay frequency (monthly, quarterly or annual).
 *
 * WHAT IT IS NOT
 *   It is not applied at checkout and never changes an order's total or a product's
 *   price. It is accrued from orders, shown in reports, and CHC credits it outside
 *   the portal. That keeps it a separate thing from any discount on a product.
 *
 * HOW IT IS COUNTED
 *   - Cancelled orders do not count. Lines still waiting for a price (price on
 *     request) do not count until the order is priced.
 *   - An item that matches more than one rule earns the single highest percent, so
 *     nothing is paid twice.
 *   - A rule can have start and end dates; an order counts for a rule only if it
 *     was placed (Toronto date) inside them.
 *   - Periods are calendar months, calendar quarters or calendar years in Toronto
 *     time, so an order placed late on the last evening of a month stays in it.
 *   - Brand and category come from the order line when it has them (orders placed
 *     from now on freeze them) and from the product otherwise.
 *
 * Pure apart from the two loaders at the bottom.
 */

const TZ = 'America/Toronto';
const FREQUENCIES = ['monthly', 'quarterly', 'annual'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const cents = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const fold = s => String(s == null ? '' : s).trim().toLowerCase();

const tzFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
/** The Toronto calendar date of a timestamp: { y, m, d, date: 'YYYY-MM-DD' }. */
function torontoDate(ts) {
    const d = ts instanceof Date ? ts : new Date(ts);
    if (Number.isNaN(d.getTime())) return null;
    const p = Object.fromEntries(tzFmt.formatToParts(d).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
    return { y: Number(p.year), m: Number(p.month), d: Number(p.day), date: `${p.year}-${p.month}-${p.day}` };
}

/** Period containing a Toronto date, for a frequency. */
function periodOf(frequency, t) {
    const pad = n => String(n).padStart(2, '0');
    if (frequency === 'annual') {
        return { key: `${t.y}`, label: `${t.y}`, start: `${t.y}-01-01`, end: `${t.y}-12-31` };
    }
    if (frequency === 'quarterly') {
        const q = Math.floor((t.m - 1) / 3);
        const sm = q * 3 + 1, em = sm + 2;
        const lastDay = new Date(Date.UTC(t.y, em, 0)).getUTCDate();
        return { key: `${t.y}-Q${q + 1}`, label: `Q${q + 1} ${t.y}`, start: `${t.y}-${pad(sm)}-01`, end: `${t.y}-${pad(em)}-${pad(lastDay)}` };
    }
    const lastDay = new Date(Date.UTC(t.y, t.m, 0)).getUTCDate();
    return { key: `${t.y}-${pad(t.m)}`, label: `${MONTHS[t.m - 1]} ${t.y}`, start: `${t.y}-${pad(t.m)}-01`, end: `${t.y}-${pad(t.m)}-${pad(lastDay)}` };
}

const cleanList = v => [...new Set((Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\n,;]+/))
    .map(x => String(x).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 100)
    .map(x => x.slice(0, 120));
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));

/** Clean and validate what an admin typed. Returns { value } or { error }. */
function normalizeRebateRule(input) {
    const b = input && typeof input === 'object' ? input : {};
    const percent = Number(b.percent);
    if (!Number.isFinite(percent) || percent <= 0) return { error: 'Enter a rebate percent greater than zero.' };
    if (percent > 100) return { error: 'A rebate can not be more than 100%.' };
    const applies_to = b.applies_to === 'selected' ? 'selected' : (b.applies_to === 'all' || !b.applies_to ? 'all' : null);
    if (!applies_to) return { error: 'Choose whether the rebate covers everything or selected categories and brands.' };
    const categories = applies_to === 'selected' ? cleanList(b.categories) : [];
    const brands = applies_to === 'selected' ? cleanList(b.brands) : [];
    if (applies_to === 'selected' && !categories.length && !brands.length) {
        return { error: 'Choose at least one category or brand, or set the rebate to cover everything.' };
    }
    const frequency = b.frequency || 'monthly';
    if (!FREQUENCIES.includes(frequency)) return { error: 'Choose monthly, quarterly or annual.' };
    const starts_on = b.starts_on ? String(b.starts_on) : null;
    const ends_on = b.ends_on ? String(b.ends_on) : null;
    if (starts_on && !isDate(starts_on)) return { error: 'The start date is not a valid date.' };
    if (ends_on && !isDate(ends_on)) return { error: 'The end date is not a valid date.' };
    if (starts_on && ends_on && starts_on > ends_on) return { error: 'The end date is before the start date.' };
    const label = String(b.label == null ? '' : b.label).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Rebate';
    return {
        value: {
            label, percent: Math.round(percent * 1000) / 1000, applies_to, categories, brands, frequency,
            starts_on, ends_on, is_active: b.is_active !== false
        }
    };
}

const inEffect = (rule, date) => (!rule.starts_on || date >= String(rule.starts_on)) && (!rule.ends_on || date <= String(rule.ends_on));

function lineMatches(rule, item) {
    if (rule.applies_to !== 'selected') return true;
    const cats = (rule.categories || []).map(fold);
    const brands = (rule.brands || []).map(fold);
    return (item.category && cats.includes(fold(item.category))) || (item.brand && brands.includes(fold(item.brand)));
}

/**
 * Work out the rebate for a set of orders.
 *   orders    [{ id, status, created_at, items: [{ product_id, subtotal, price_on_request, brand?, category? }] }]
 *   rules     company_rebate_rules rows
 *   itemInfo  Map(product_id -> { brand, category }) for lines that did not freeze them
 *   now       injectable clock, for "is this period finished?"
 * Returns { rows, totals, rules_active } with one row per (rule, period), newest period first.
 */
function computeRebates({ orders, rules, itemInfo, now = new Date() }) {
    const active = (rules || []).filter(r => r && r.is_active !== false);
    const info = itemInfo instanceof Map ? itemInfo : new Map();
    const today = torontoDate(now).date;
    const buckets = new Map();

    for (const o of orders || []) {
        if (!o || o.status === 'cancelled') continue;
        const t = torontoDate(o.created_at);
        if (!t) continue;
        const inScope = active.filter(r => inEffect(r, t.date));
        if (!inScope.length) continue;

        for (const it of Array.isArray(o.items) ? o.items : []) {
            const spend = Number(it && it.subtotal);
            if (!it || it.price_on_request || !(spend > 0)) continue;
            const known = info.get(it.product_id) || {};
            const line = { brand: it.brand || known.brand || '', category: it.category || known.category || '' };

            // Highest matching percent wins; on a tie the older rule wins, so the answer is stable.
            let winner = null;
            for (const r of inScope) {
                if (!lineMatches(r, line)) continue;
                if (!winner || Number(r.percent) > Number(winner.percent)) winner = r;
            }
            if (!winner) continue;

            const p = periodOf(winner.frequency || 'monthly', t);
            const key = `${winner.id || winner.label}|${p.key}`;
            let b = buckets.get(key);
            if (!b) {
                b = {
                    rule_id: winner.id || null, label: winner.label, frequency: winner.frequency || 'monthly',
                    percent: Number(winner.percent), applies_to: winner.applies_to,
                    period_key: p.key, period_label: p.label, period_start: p.start, period_end: p.end,
                    complete: p.end < today, eligible_spend: 0, rebate_raw: 0, _orders: new Set()
                };
                buckets.set(key, b);
            }
            b.eligible_spend += spend;
            b.rebate_raw += spend * Number(winner.percent) / 100;
            b._orders.add(o.id);
        }
    }

    const rows = [...buckets.values()].map(b => ({
        rule_id: b.rule_id, label: b.label, frequency: b.frequency, percent: b.percent, applies_to: b.applies_to,
        period_key: b.period_key, period_label: b.period_label, period_start: b.period_start, period_end: b.period_end,
        complete: b.complete, orders: b._orders.size,
        eligible_spend: cents(b.eligible_spend), rebate: cents(b.rebate_raw)
    })).sort((a, b) => (a.period_start < b.period_start ? 1 : a.period_start > b.period_start ? -1 : String(a.label).localeCompare(String(b.label))));

    return {
        rows,
        totals: {
            eligible_spend: cents(rows.reduce((s, r) => s + r.eligible_spend, 0)),
            rebate: cents(rows.reduce((s, r) => s + r.rebate, 0))
        },
        rules_active: active.length
    };
}

/** Rebate rules for a company. A database without migration 047 yet means "none". */
async function loadRebateRules(supabase, companyId) {
    const { data, error } = await supabase.from('company_rebate_rules')
        .select('id, label, percent, applies_to, categories, brands, frequency, starts_on, ends_on, is_active, created_at')
        .eq('company_id', companyId).order('created_at');
    if (error) {
        if (/company_rebate_rules|relation .* does not exist|schema cache/i.test(error.message || '')) return [];
        throw error;
    }
    return data || [];
}

/** Brand and category for the product ids on these orders (only the ones lines did not freeze). */
async function loadItemInfo(supabase, companyId, orders) {
    const ids = new Set();
    for (const o of orders || []) for (const it of Array.isArray(o.items) ? o.items : []) {
        if (it && it.product_id && !(it.brand && it.category)) ids.add(it.product_id);
    }
    const map = new Map();
    const list = [...ids];
    for (let i = 0; i < list.length; i += 200) {
        const { data } = await supabase.from('products').select('id, brand, category')
            .eq('company_id', companyId).in('id', list.slice(i, i + 200));
        for (const p of data || []) map.set(p.id, { brand: p.brand || '', category: p.category || '' });
    }
    return map;
}

/**
 * Every order for a company in a date range, read a page at a time. A rebate is
 * money, so a silently truncated read (the database caps one request) would
 * understate it; paging until a short page makes that impossible.
 * `from` / `to` are ISO timestamps (inclusive); `locationId` narrows to one shop.
 */
async function fetchOrdersForRebate(supabase, { companyId, from, to, locationId }) {
    const PAGE = 1000, HARD_CAP = 100000;
    const out = [];
    for (let start = 0; start < HARD_CAP; start += PAGE) {
        let q = supabase.from('orders')
            .select('id, status, created_at, location_id, items')
            .eq('company_id', companyId)
            .order('created_at', { ascending: true }).order('id', { ascending: true })
            .range(start, start + PAGE - 1);
        if (locationId) q = q.eq('location_id', locationId);
        if (from) q = q.gte('created_at', from);
        if (to) q = q.lte('created_at', to);
        const { data, error } = await q;
        if (error) throw error;
        out.push(...(data || []));
        if (!data || data.length < PAGE) return out;
    }
    throw new Error('Too many orders to total in one report. Narrow the dates.');
}

/** Orders in range -> rebate rows for one company. */
async function rebateReportFor(supabase, { companyId, from, to, locationId, now }) {
    const rules = await loadRebateRules(supabase, companyId);
    if (!rules.length) return { rules, rows: [], totals: { eligible_spend: 0, rebate: 0 }, rules_active: 0 };
    const orders = await fetchOrdersForRebate(supabase, { companyId, from, to, locationId });
    const itemInfo = await loadItemInfo(supabase, companyId, orders);
    return { rules, ...computeRebates({ orders, rules, itemInfo, now }) };
}

module.exports = {
    fetchOrdersForRebate, rebateReportFor,
    FREQUENCIES, TZ, torontoDate, periodOf, normalizeRebateRule, lineMatches, inEffect,
    computeRebates, loadRebateRules, loadItemInfo
};
