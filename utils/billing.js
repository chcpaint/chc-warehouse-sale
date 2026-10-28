/**
 * utils/billing.js
 *
 * What can be sold, what it costs, and who is allowed to use what. Pure
 * functions only -- no database, no Stripe -- so the storefront, the admin
 * console, the webhook and the tests cannot disagree about any of it.
 * (Database access is in utils/billing-db.js, Stripe in utils/billing-stripe.js.)
 *
 * The sales portal (ordering) is always free and is not an item here.
 *
 * Each company is in one of two modes (companies.settings.billing.mode):
 *   free  - everything the distributor has switched on works, no charge. This
 *           is the default, so nothing changes for anyone until a distributor
 *           decides a customer should pay.
 *   paid  - the optional modules only work for the items the company has an
 *           entitlement for (bought, comped at $0, or priced at $0).
 *
 * The entitled list is cached on the company's settings
 * (settings.billing.entitled) so utils/modules.js can answer "is this on?"
 * with no database call.
 */

/** Item keys, in the order they are shown. `complete` is the bundle. */
const ITEMS = {
    inventory: {
        key: 'inventory', label: 'refinishAI Inventory', unit: 'location',
        blurb: 'Scanner-driven stock control, cycle counts, transfers and automatic reordering.',
        modules: ['inventory'], requires: [], default_month_cents: 12900
    },
    kits: {
        key: 'kits', label: 'Repair kits', unit: 'location',
        blurb: 'Expense a job’s materials in one action, against a repair order number. Needs Inventory.',
        modules: ['kits'], requires: ['inventory'], default_month_cents: 4900
    },
    people: {
        key: 'people', label: 'People & activity', unit: 'company',
        blurb: 'Groups, who ordered, what each person spends, sign-in history, and reports for signed-in accounts.',
        modules: ['activity', 'restricted_reports'], requires: [], default_month_cents: 3900
    },
    shopsafe: {
        key: 'shopsafe', label: 'refinishAI ShopSafe', unit: 'location',
        blurb: 'Health, safety and environmental compliance records with an SDS library.',
        modules: ['shopsafe'], requires: [], default_month_cents: 4900
    },
    complete: {
        key: 'complete', label: 'Complete (everything)', unit: 'location',
        blurb: 'Inventory, Repair kits, People & activity and ShopSafe together, at a bundle price.',
        modules: [], requires: [], bundle: ['inventory', 'kits', 'people', 'shopsafe'], default_month_cents: 19900
    }
};
const ITEM_KEYS = Object.keys(ITEMS);
const INTERVALS = ['month', 'year'];
const ANNUAL_MONTHS = 10; // pay for 10 months, get 12

const COUNTED = new Set(['active', 'trialing', 'past_due', 'comped']);

/** Default price in cents for an item/interval. Annual = ten months. */
function defaultPrice(item, interval) {
    const spec = ITEMS[item];
    if (!spec) return null;
    return interval === 'year' ? spec.default_month_cents * ANNUAL_MONTHS : spec.default_month_cents;
}

function currencyFor(country) { return country === 'US' ? 'usd' : 'cad'; }

/**
 * The prices that apply to one distributor's customers.
 * Order: that distributor's own row, then a platform-wide row, then the code default.
 * @param {Array} rows billing_prices rows (any distributors; filtered here)
 * @returns {Record<string, {month:number, year:number, currency:string, overridden:{month:boolean, year:boolean}}>}
 */
function resolvePrices(rows, distributorId, country) {
    const out = {};
    for (const item of ITEM_KEYS) {
        out[item] = { currency: currencyFor(country), overridden: { month: false, year: false } };
        for (const interval of INTERVALS) {
            const own = (rows || []).find(r => r.item === item && r.interval === interval && distributorId && r.distributor_id === distributorId);
            const platform = (rows || []).find(r => r.item === item && r.interval === interval && !r.distributor_id);
            const hit = own || platform;
            out[item][interval] = hit ? Number(hit.unit_amount_cents) : defaultPrice(item, interval);
            out[item].overridden[interval] = !!own;
            if (hit && hit.currency) out[item].currency = hit.currency;
        }
    }
    return out;
}

/** Items a bundle expands to (a plain item expands to itself). */
function expand(item) {
    const spec = ITEMS[item];
    if (!spec) return [];
    return spec.bundle ? [...spec.bundle] : [item];
}

/** Entitlement rows that currently grant access. */
function activeRows(rows, now = Date.now()) {
    return (rows || []).filter(r => {
        if (!COUNTED.has(r.status)) return false;
        if (r.source === 'comp' && r.comp_until && new Date(r.comp_until).getTime() < now) return false;
        return true;
    });
}

/** Component item keys the company is entitled to (bundles expanded, sorted). */
function entitledItems(rows, now) {
    const set = new Set();
    for (const r of activeRows(rows, now)) for (const k of expand(r.item)) set.add(k);
    return [...set].sort();
}

function billingConfig(companySettings) {
    const raw = (companySettings && typeof companySettings === 'object' && companySettings.billing) || {};
    return {
        mode: raw.mode === 'paid' ? 'paid' : 'free',
        entitled: Array.isArray(raw.entitled) ? raw.entitled.filter(k => ITEMS[k]) : []
    };
}

/** Which billing item a module belongs to, or null when it is free. */
function itemForModule(moduleName) {
    for (const k of ITEM_KEYS) if (ITEMS[k].modules.includes(moduleName)) return k;
    return null;
}

/** May this module be used, as far as billing is concerned? Free-mode companies: always. */
function billingAllows(companySettings, moduleName) {
    const cfg = billingConfig(companySettings);
    if (cfg.mode !== 'paid') return true;
    const item = itemForModule(moduleName);
    if (!item) return true;
    return cfg.entitled.includes(item);
}

/**
 * Company settings as the customer's browser should see them: any billed module
 * the company is not entitled to reads as switched off, so the console never
 * shows a tab the server would refuse. Free-mode companies are returned as-is.
 */
function clientSettings(companySettings) {
    const cfg = billingConfig(companySettings);
    if (cfg.mode !== 'paid') return companySettings;
    const out = { ...companySettings };
    for (const k of ITEM_KEYS) for (const m of ITEMS[k].modules) {
        if (!billingAllows(companySettings, m)) out[m] = { ...(companySettings[m] || {}), enabled: false };
    }
    return out;
}

/** The new settings.billing block after an entitlement change, keeping the mode. */
function withEntitled(companySettings, rows, now) {
    const base = (companySettings && typeof companySettings === 'object') ? companySettings : {};
    const cfg = billingConfig(base);
    return { ...base, billing: { ...(base.billing || {}), mode: cfg.mode, entitled: entitledItems(rows, now) } };
}

/**
 * Price a purchase.
 *
 * `items`   what the customer ticked (any of ITEM_KEYS)
 * `owned`   component items they already have, so they are not charged twice
 * `locations` how many locations the per-location items cover
 *
 * Choosing the bundle replaces the pieces it contains. Repair kits need
 * Inventory (ticked or already owned).
 */
function quote({ items, interval, locations, prices, owned = [] }) {
    if (!INTERVALS.includes(interval)) return { ok: false, error: 'Choose monthly or annual billing.' };
    const wanted = [...new Set((items || []).filter(k => ITEMS[k]))];
    if (!wanted.length) return { ok: false, error: 'Choose at least one item.' };
    const locs = Number.isInteger(locations) ? locations : parseInt(locations, 10);
    if (!(locs >= 1 && locs <= 500)) return { ok: false, error: 'Locations must be between 1 and 500.' };

    let chosen = wanted;
    if (chosen.includes('complete')) chosen = ['complete'];
    const ownedSet = new Set(owned);
    chosen = chosen.filter(k => !expand(k).every(c => ownedSet.has(c)));
    if (!chosen.length) return { ok: false, error: 'You already have everything you picked.' };

    const have = new Set([...ownedSet, ...chosen.flatMap(expand)]);
    for (const k of chosen) for (const dep of ITEMS[k].requires) {
        if (!have.has(dep)) return { ok: false, error: `${ITEMS[k].label} needs ${ITEMS[dep].label}. Add it too.` };
    }

    const lines = chosen.map(k => {
        const qty = ITEMS[k].unit === 'company' ? 1 : locs;
        const unit = prices[k][interval];
        return { item: k, label: ITEMS[k].label, unit: ITEMS[k].unit, quantity: qty, unit_amount_cents: unit, amount_cents: unit * qty, covers: expand(k) };
    });
    const total = lines.reduce((s, l) => s + l.amount_cents, 0);

    // Would the bundle be cheaper than what was ticked? Worth telling them.
    let bundle_saves_cents = 0;
    if (!chosen.includes('complete') && !ownedSet.size) {
        const b = prices.complete[interval] * locs;
        const covered = ['inventory', 'kits', 'people', 'shopsafe'];
        if (covered.every(c => have.has(c)) && b < total) bundle_saves_cents = total - b;
    }

    return { ok: true, interval, locations: locs, currency: prices[chosen[0]].currency, lines, total_cents: total, bundle_saves_cents };
}

/** Per-month equivalent of a recurring amount, for reporting. */
function monthlyCents(amountCents, interval) {
    return interval === 'year' ? Math.round(amountCents / 12) : amountCents;
}

function formatMoney(cents, currency) {
    const n = (Number(cents) / 100).toFixed(2);
    return `${currency === 'usd' ? 'US$' : 'CA$'}${n}`;
}

module.exports = {
    ITEMS, ITEM_KEYS, INTERVALS, ANNUAL_MONTHS,
    defaultPrice, resolvePrices, expand, activeRows, entitledItems,
    billingConfig, itemForModule, billingAllows, withEntitled, clientSettings,
    quote, monthlyCents, formatMoney, currencyFor
};
