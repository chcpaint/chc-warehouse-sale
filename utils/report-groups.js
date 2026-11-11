/**
 * utils/report-groups.js -- PPG paint lines vs sundries.
 *
 * Every item a shop buys falls in one of two reporting groups:
 *
 *   ppg       paint-based products from a PPG line: Envirobase / EHP, Shopline,
 *             OneChoice, Deltron, Delfleet (Essential and Evolution), Omni,
 *             Vibrance, Nexa Autocolor, and any other PPG paint product;
 *   sundries  everything else -- every other brand, and PPG-branded general
 *             items that are not paint (paint suits, masking paper, mixing
 *             cups and sticks, cans and lids, spray-out cards, test panels,
 *             display and shop equipment).
 *
 * The rule, in order:
 *   1. An override CHC set for the part number wins (table report_item_groups).
 *   2. Not a PPG item at all (brand, name and category say nothing about PPG
 *      or one of its lines) -> sundries.
 *   3. A PPG item that is a general, non-paint item -> sundries.
 *   4. Otherwise -> PPG, attributed to its line where the brand, name or part
 *      number shows it, else "Other PPG".
 *
 * Pure functions only. Loading orders and overrides lives in the routes.
 */

const { torontoParts } = require('./brand-sales-report');

const GROUPS = ['ppg', 'sundries'];
const GROUP_LABEL = { ppg: 'PPG paint lines', sundries: 'Sundries' };
const CANCELLED = new Set(['cancelled', 'canceled']);

// Lines, as they appear in a brand or an item name.
const LINES = [
    { label: 'Envirobase / EHP', re: /\b(envirobase|enviro\s*base|enviro|ehp)\b/i },
    { label: 'Shopline',         re: /\bshop[\s-]?line\b/i },
    { label: 'OneChoice',        re: /\bone[\s-]?choice\b/i },
    { label: 'Delfleet',         re: /\bdelfleet\b/i },
    { label: 'Deltron',          re: /\bdeltron\b/i },
    { label: 'Omni',             re: /\bomni\b/i },
    { label: 'Vibrance',         re: /\bvibrance\b/i },
    { label: 'Nexa Autocolor',   re: /\b(nexa|aquabase)\b/i }
];
const OTHER_PPG = 'Other PPG';

// PPG part-number families, used only to name the line of an item already
// known to be a PPG paint product (never to decide that something is PPG).
const SKU_LINES = [
    { label: 'Envirobase / EHP', re: /^(T[45]\d|ECS?\d|EH\d|EA\d|EHP)/i },
    { label: 'Shopline',         re: /^J[CPHRTA]?\d/i },
    { label: 'OneChoice',        re: /^S(U|X|L|CA)\d/i },
    { label: 'Delfleet',         re: /^(ES[BCHMRSUX]\d|F[34]\d)/i },
    { label: 'Deltron',          re: /^D(X|P|T|CU|AU|BC|MD|MX|CX|CH|CA)\d/i },
    { label: 'Omni',             re: /^M[CPRHX]\d/i }
];

const PPG_BRAND = /^\s*(ppg|omni|one[\s-]?choice|deltron|shop[\s-]?line|envirobase|delfleet|nexa|vibrance|aquabase)\b/i;
const PPG_WORD = /\bppg\b/i;

// General, non-paint items. Checked against the item's name and category.
const GENERAL_CATEGORIES = new Set(['masks/suits', 'equip/filter/booth', 'pps/cans']);
const GENERAL_TERMS = new RegExp('\\b(' + [
    'paint suits?', 'suits?', 'coveralls?', 'hats?', 'caps', 'gloves?', 'respirators?', 'aprons?',
    'masking', 'masks?', 'paper', 'tape', 'crash wrap',
    'cups?', 'lids?', 'strainers?', 'sticks?', 'paddles?', 'spouts?', 'can w/ ?lid', 'cans',
    'spray ?out cards?', 'cards?', 'crds', 'spray ?out binder', 'test panels?', 'panel holder', 'speed shapes',
    'catalogues?', 'catalogs?', 'colou?r books?', 'posters?', 'signs?', 'labels?', 'msds',
    'cables?', 'cords?', 'extension', 'extention', 'surge strip', 'battery', 'back-?up', 'computer', 'monitor', 'printer',
    'software', 'touch ?screen', 'touchmix', 'docking', 'port', 'internet', 'fees?', 'rapid match', 'paint manager', 'linq',
    'scanner', 'spe[ck]?trophotometer', 'spetrophotometer', 'clock', 'display', 'cover', 'cvr',
    'racks?', 'shelf', 'shelves', 'cabinet', 'stand', 'platform', 'holder', 'hanger', 'mixing tables?', 'tables?',
    'mixing unit', 'mix bank', 'primer bank', 'mixing machine', 'motor', 'shaker', 'collar', 'hardware kit',
    'led light', 'uv light', 'scales?', 'booth', 'filters?', 'gas tank', 'carrying case',
    'tack rags?', 'rags?', 'wipes', 'sponges?', 'towels?', 'bags?', 'sheeting', 'razor', 'blades?', 'knife', 'amplifier',
    'hoses?', 'bottles?', 'pourer', 'thermometers?', 'parts',
    'spray guns?', 'guns?(?!\\s*(cleaner|wash))'
].join('|') + ')\\b', 'i');

const fold = v => String(v == null ? '' : v).trim().toLowerCase();
const skuKey = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
const cents = n => Math.round((Number(n) || 0) * 100) / 100;

function lineFromText(text) {
    for (const l of LINES) if (l.re.test(text)) return l.label;
    return null;
}

/**
 * Which group an item belongs to.
 *   item       { brand, category, name, sku }
 *   overrides  Map(skuKey -> 'ppg' | 'sundries')
 * Returns { group, line, reason }.
 */
function classify(item, overrides) {
    const it = item || {};
    const brand = String(it.brand || '');
    const name = String(it.name || '');
    const category = String(it.category || '');
    const key = skuKey(it.sku);

    const forced = key && overrides && overrides.get ? overrides.get(key) : null;
    if (forced === 'ppg' || forced === 'sundries') {
        const line = forced === 'ppg' ? (lineFromText(`${brand} ${name}`) || skuLine(it.sku) || OTHER_PPG) : null;
        return { group: forced, line, reason: 'Set by CHC' };
    }

    const text = `${brand} ${name} ${category}`;
    const isPpg = PPG_BRAND.test(brand) || PPG_WORD.test(text) || !!lineFromText(text);
    if (!isPpg) return { group: 'sundries', line: null, reason: 'Not a PPG line' };

    if (GENERAL_CATEGORIES.has(fold(category)) || GENERAL_TERMS.test(name)) {
        return { group: 'sundries', line: null, reason: 'PPG general item, not paint' };
    }

    return { group: 'ppg', line: lineFromText(`${brand} ${name}`) || skuLine(it.sku) || OTHER_PPG, reason: 'PPG paint line' };
}

function skuLine(sku) {
    const s = String(sku || '').trim();
    for (const l of SKU_LINES) if (l.re.test(s)) return l.label;
    return null;
}

const lineQty = l => {
    const q = Number(l.quantity != null ? l.quantity : l.qty);
    return Number.isFinite(q) && q > 0 ? q : 0;
};

/** Item dollars before tax, or null when the line was never priced. */
function lineDollars(l, qty) {
    if (l.price_on_request === true) return null;
    if (l.subtotal != null && l.subtotal !== '' && Number.isFinite(Number(l.subtotal))) return Number(l.subtotal);
    const p = Number(l.unit_price != null ? l.unit_price : l.price);
    return Number.isFinite(p) && p > 0 ? p * qty : null;
}

function emptyPair() {
    const z = () => ({ qty: 0, amount: 0, unpriced_qty: 0, orders: new Set() });
    return { ppg: z(), sundries: z() };
}
function add(pair, group, qty, dollars, orderId) {
    const b = pair[group];
    b.qty += qty;
    if (dollars == null) b.unpriced_qty += qty; else b.amount += dollars;
    b.orders.add(orderId);
}
function finish(pair) {
    const out = {};
    let total = 0;
    for (const g of GROUPS) total += pair[g].amount;
    for (const g of GROUPS) {
        const b = pair[g];
        out[g] = { qty: b.qty, amount: cents(b.amount), unpriced_qty: b.unpriced_qty, orders: b.orders.size,
                   share: total > 0 ? Math.round((b.amount / total) * 1000) / 10 : 0 };
    }
    out.total = { amount: cents(total) };
    return out;
}

/**
 * Split a set of orders into PPG paint lines and sundries, by shop, by month
 * and by item.
 *
 *   orders     [{ id, status, created_at, location, location_id, items: [line] }]
 *   itemInfo   Map(product_id -> { brand, category }) for lines that did not freeze them
 *   overrides  Map(skuKey -> group)
 *
 * Cancelled orders are left out. Dates are the order date in Toronto time,
 * the same date the rest of the Reports screen uses.
 */
function buildSplit({ orders, itemInfo, overrides }) {
    const totals = emptyPair();
    const shops = new Map();       // shop key -> { location_id, location, pair }
    const months = new Map();      // period -> pair
    const shopMonths = new Map();  // shop|period -> { location, period, pair }
    const items = new Map();       // group|sku -> row
    const lines = new Map();       // ppg line -> { qty, amount, unpriced_qty }
    let orderCount = 0;

    for (const o of orders || []) {
        if (!o || CANCELLED.has(fold(o.status))) continue;
        const t = torontoParts(o.created_at);
        if (!t) continue;
        const list = Array.isArray(o.items) ? o.items : [];
        if (!list.length) continue;
        orderCount += 1;

        const shopName = (o.location && String(o.location).trim()) || 'Unassigned';
        const shopKey = o.location_id || `name:${shopName}`;
        let shop = shops.get(shopKey);
        if (!shop) { shop = { location_id: o.location_id || null, location: shopName, pair: emptyPair() }; shops.set(shopKey, shop); }
        if (!months.has(t.period)) months.set(t.period, emptyPair());
        const smKey = `${shopKey}|${t.period}`;
        if (!shopMonths.has(smKey)) shopMonths.set(smKey, { location_id: shop.location_id, location: shopName, period: t.period, pair: emptyPair() });

        for (const l of list) {
            if (!l) continue;
            const qty = lineQty(l);
            if (!qty) continue;
            const known = (itemInfo && itemInfo.get && itemInfo.get(l.product_id)) || {};
            const c = classify({ brand: l.brand || known.brand, category: l.category || known.category, name: l.name, sku: l.sku }, overrides);
            const dollars = lineDollars(l, qty);

            add(totals, c.group, qty, dollars, o.id);
            add(shop.pair, c.group, qty, dollars, o.id);
            add(months.get(t.period), c.group, qty, dollars, o.id);
            add(shopMonths.get(smKey).pair, c.group, qty, dollars, o.id);

            const ik = `${c.group}|${skuKey(l.sku) || fold(l.name)}`;
            let row = items.get(ik);
            if (!row) {
                row = { group: c.group, line: c.line, reason: c.reason, sku: l.sku || '', name: l.name || '',
                        qty: 0, amount: 0, unpriced_qty: 0, _o: new Set(), _s: new Set() };
                items.set(ik, row);
            }
            row.qty += qty;
            if (dollars == null) row.unpriced_qty += qty; else row.amount += dollars;
            row._o.add(o.id); row._s.add(shopName);

            if (c.group === 'ppg') {
                let ln = lines.get(c.line);
                if (!ln) { ln = { line: c.line, qty: 0, amount: 0, unpriced_qty: 0 }; lines.set(c.line, ln); }
                ln.qty += qty;
                if (dollars == null) ln.unpriced_qty += qty; else ln.amount += dollars;
            }
        }
    }

    const byName = (a, b) => String(a).localeCompare(String(b), 'en', { sensitivity: 'base' });
    return {
        orders: orderCount,
        totals: finish(totals),
        shops: [...shops.values()].map(s => ({ location_id: s.location_id, location: s.location, ...finish(s.pair) }))
            .sort((a, b) => b.total.amount - a.total.amount || byName(a.location, b.location)),
        months: [...months.entries()].map(([period, p]) => ({ period, ...finish(p) }))
            .sort((a, b) => a.period.localeCompare(b.period)),
        shop_months: [...shopMonths.values()].map(s => ({ location_id: s.location_id, location: s.location, period: s.period, ...finish(s.pair) }))
            .sort((a, b) => a.period.localeCompare(b.period) || byName(a.location, b.location)),
        items: [...items.values()].map(r => ({
            group: r.group, line: r.line, reason: r.reason, sku: r.sku, name: r.name, qty: r.qty,
            amount: cents(r.amount), unpriced_qty: r.unpriced_qty, orders: r._o.size, shops: [...r._s].sort(byName)
        })).sort((a, b) => a.group.localeCompare(b.group) || b.amount - a.amount || b.qty - a.qty || byName(a.sku, b.sku)),
        ppg_lines: [...lines.values()].map(l => ({ ...l, amount: cents(l.amount) }))
            .sort((a, b) => b.amount - a.amount || byName(a.line, b.line))
    };
}

/** Remove every dollar figure (for companies that hide pricing). Units stay. */
function stripDollars(report) {
    const clean = obj => {
        if (Array.isArray(obj)) return obj.map(clean);
        if (!obj || typeof obj !== 'object') return obj;
        const out = {};
        for (const [k, v] of Object.entries(obj)) {
            if (k === 'amount' || k === 'share') continue;
            out[k] = clean(v);
        }
        return out;
    };
    return { ...clean(report), pricing_hidden: true };
}

const BASIS_TEXT = 'PPG paint lines are paint-based products from PPG lines (Envirobase / EHP, Shopline, OneChoice, Deltron, Delfleet, Omni and other PPG paint). ' +
    'Sundries are everything else, including PPG-branded general items such as paint suits, masking paper, mixing cups and spray-out cards. ' +
    'Dollars are item dollars before tax, delivery fee and fuel surcharge, by order date. Cancelled orders are not counted.';

/** Overrides as a Map(skuKey -> group). A database without migration 063 yet means "none". */
async function loadOverrides(supabase) {
    const { data, error } = await supabase.from('report_item_groups').select('sku_key, report_group');
    if (error) {
        if (/report_item_groups|relation .* does not exist|schema cache/i.test(error.message || '')) return new Map();
        throw error;
    }
    return new Map((data || []).map(r => [r.sku_key, r.report_group]));
}

module.exports = {
    GROUPS, GROUP_LABEL, LINES, OTHER_PPG, BASIS_TEXT,
    classify, skuLine, skuKey, lineDollars, buildSplit, stripDollars, loadOverrides
};

/**
 * Orders for the split, read a page at a time (a silent cap would understate
 * the totals). `from` / `to` are ISO timestamps, inclusive.
 */
async function loadSplitOrders(supabase, { companyId, locationId, from, to }) {
    const PAGE = 1000, HARD_CAP = 100000;
    const out = [];
    for (let start = 0; start < HARD_CAP; start += PAGE) {
        let q = supabase.from('orders')
            .select('id, status, created_at, location, location_id, items')
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

/** Everything a PPG vs sundries report needs, for one company. */
async function splitReportFor(supabase, { companyId, locationId, from, to }) {
    const { loadItemInfo } = require('./rebates');
    const orders = await loadSplitOrders(supabase, { companyId, locationId, from, to });
    const [itemInfo, overrides] = await Promise.all([loadItemInfo(supabase, companyId, orders), loadOverrides(supabase)]);
    return { basis: BASIS_TEXT, ...buildSplit({ orders, itemInfo, overrides }) };
}

module.exports.loadSplitOrders = loadSplitOrders;
module.exports.splitReportFor = splitReportFor;
