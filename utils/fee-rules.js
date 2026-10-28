/**
 * utils/fee-rules.js
 *
 * Delivery fees and fuel surcharges, as rules a company can have.
 *
 * A rule says: charge this much (a flat dollar amount, or a percent of the item
 * subtotal), always, or only when the order is under / at-or-over a dollar amount,
 * and for everyone ordering for the company or only people in chosen user groups.
 * Every rule that applies adds one line to the order.
 *
 * THE ONE FUNCTION EVERYONE USES
 *   resolveFees() is the only place that decides what an order is charged. The
 *   storefront, the replenishment-approval order path and the console's price edit
 *   all call it, so they cannot disagree. The store's cart shows a preview with the
 *   same rules, but the order is always priced here, on the server.
 *
 * BACKWARDS COMPATIBLE ON PURPOSE
 *   A company with NO fee rules at all keeps the old behaviour from
 *   utils/delivery-fee.js: $10 on an order under $300, unless that account was
 *   switched off. The moment a company has any fee rule (even a paused one) its
 *   rules are the whole story and the old setting is ignored. So nothing changes
 *   for a company until someone sets it up, and "no fees" for a company with rules
 *   is simply "no active rules".
 *
 * Fees are not taxed: that is how the delivery fee has always worked here.
 * Money is rounded to the cent here, once.
 */

const { deliveryFeeSettings, THRESHOLD, FEE } = require('./delivery-fee');

const KINDS = ['delivery', 'fuel'];
const CALCS = ['flat', 'percent'];
const CONDITIONS = ['always', 'below', 'at_or_above'];
const DEFAULT_LABEL = { delivery: 'Delivery fee', fuel: 'Fuel surcharge' };
const MAX_FLAT = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cents = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const money = n => '$' + cents(n).toFixed(2);

/**
 * Clean and validate what an admin typed. Returns { value } or { error }.
 * Nothing here trusts the caller: kinds, calcs and conditions are whitelisted,
 * numbers are bounded and the label is plain text.
 */
function normalizeFeeRule(input) {
    const b = input && typeof input === 'object' ? input : {};
    if (!KINDS.includes(b.kind)) return { error: 'Choose whether this is a delivery fee or a fuel surcharge.' };
    if (!CALCS.includes(b.calc)) return { error: 'Choose a flat dollar amount or a percent of the order.' };
    if (!CONDITIONS.includes(b.condition || 'always')) return { error: 'Choose when the fee applies.' };
    const condition = b.condition || 'always';

    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) return { error: 'Enter an amount greater than zero.' };
    if (b.calc === 'percent' && amount > 100) return { error: 'A percent can not be more than 100.' };
    if (b.calc === 'flat' && amount > MAX_FLAT) return { error: `A flat fee can not be more than ${money(MAX_FLAT)}.` };

    let threshold = null;
    if (condition !== 'always') {
        threshold = Number(b.threshold);
        if (b.threshold === '' || b.threshold === null || b.threshold === undefined || !Number.isFinite(threshold) || threshold < 0) {
            return { error: 'Enter the order dollar amount this rule is based on.' };
        }
        if (threshold > 1000000) return { error: 'That order amount is too large.' };
        threshold = cents(threshold);
    }

    const label = String(b.label == null ? '' : b.label).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
        || DEFAULT_LABEL[b.kind];

    const groupIds = Array.isArray(b.group_ids) ? b.group_ids : [];
    if (groupIds.some(g => !UUID_RE.test(String(g)))) return { error: 'One of the chosen user groups is not valid.' };

    return {
        value: {
            kind: b.kind, label, calc: b.calc, amount: cents(amount), condition, threshold,
            group_ids: [...new Set(groupIds.map(String))],
            is_active: b.is_active !== false
        }
    };
}

/** Does this rule charge this order? `groupId` is the ordering person's group, or null. */
function ruleApplies(rule, subtotal, groupId) {
    if (!rule || rule.is_active === false) return false;
    const groups = Array.isArray(rule.group_ids) ? rule.group_ids : [];
    if (groups.length && !(groupId && groups.includes(groupId))) return false;
    const sub = Number(subtotal) || 0;
    const t = Number(rule.threshold);
    if (rule.condition === 'below') return sub < t;
    if (rule.condition === 'at_or_above') return sub >= t;
    return true;
}

function ruleAmount(rule, subtotal) {
    return rule.calc === 'percent' ? cents((Number(subtotal) || 0) * Number(rule.amount) / 100) : cents(rule.amount);
}

/** The old $10-under-$300 behaviour, expressed as a rule so there is only one code path. */
function legacyRules(companySettings) {
    if (!deliveryFeeSettings(companySettings).enabled) return [];
    return [{
        id: null, kind: 'delivery', label: 'Delivery fee', calc: 'flat', amount: FEE,
        condition: 'below', threshold: THRESHOLD, group_ids: [], is_active: true, legacy: true
    }];
}

/**
 * What an order is charged.
 *   subtotal  priced item subtotal before tax
 *   rules     every fee-rule row for the company (active or not); [] = none configured
 *   settings  the company's raw settings column (only read when there are no rules)
 *   groupId   the ordering person's user group id, or null (shared access code)
 * Returns { lines, delivery_fee, fuel_surcharge, total, mode }.
 */
function resolveFees({ subtotal, rules, settings, groupId = null }) {
    const configured = Array.isArray(rules) && rules.length > 0;
    const effective = configured ? rules : legacyRules(settings);
    const lines = [];
    for (const r of effective) {
        if (!ruleApplies(r, subtotal, groupId)) continue;
        const amount = ruleAmount(r, subtotal);
        if (!(amount > 0)) continue;
        lines.push({ rule_id: r.id || null, kind: r.kind, label: r.label || DEFAULT_LABEL[r.kind], amount });
    }
    const sum = kind => cents(lines.filter(l => l.kind === kind).reduce((s, l) => s + l.amount, 0));
    const delivery_fee = sum('delivery');
    const fuel_surcharge = sum('fuel');
    return { lines, delivery_fee, fuel_surcharge, total: cents(delivery_fee + fuel_surcharge), mode: configured ? 'rules' : 'legacy' };
}

/**
 * The fee lines to SHOW for a stored order: the itemised list when the order has
 * one, else whatever the older delivery_fee column holds.
 */
function feeLinesOf(order) {
    if (!order) return [];
    if (Array.isArray(order.fee_lines) && order.fee_lines.length) {
        return order.fee_lines
            .map(l => ({ kind: l.kind, label: String(l.label || DEFAULT_LABEL[l.kind] || 'Fee'), amount: Number(l.amount) || 0 }))
            .filter(l => l.amount > 0);
    }
    const d = Number(order.delivery_fee) || 0;
    const f = Number(order.fuel_surcharge) || 0;
    const out = [];
    if (d > 0) out.push({ kind: 'delivery', label: 'Delivery fee', amount: d });
    if (f > 0) out.push({ kind: 'fuel', label: 'Fuel surcharge', amount: f });
    return out;
}

/** Rules for a company. A database without migration 047 yet means "none", never an error. */
async function loadFeeRules(supabase, companyId) {
    const { data, error } = await supabase.from('company_fee_rules')
        .select('id, kind, label, calc, amount, condition, threshold, group_ids, is_active, created_at')
        .eq('company_id', companyId).order('created_at');
    if (error) {
        if (/company_fee_rules|relation .* does not exist|schema cache/i.test(error.message || '')) return [];
        throw error;
    }
    return data || [];
}

/** The ordering person's group id (or null). */
async function groupIdForUser(supabase, companyUserId) {
    if (!companyUserId) return null;
    const { data } = await supabase.from('company_users').select('group_id').eq('id', companyUserId).maybeSingle();
    return (data && data.group_id) || null;
}

/** The rules a signed-in session would be charged by, in a shape safe to send to a browser. */
function publicRulesFor({ rules, settings, groupId }) {
    const configured = Array.isArray(rules) && rules.length > 0;
    const effective = configured ? rules : legacyRules(settings);
    return effective
        .filter(r => r.is_active !== false)
        .filter(r => {
            const g = Array.isArray(r.group_ids) ? r.group_ids : [];
            return !g.length || (groupId && g.includes(groupId));
        })
        .map(r => ({ kind: r.kind, label: r.label || DEFAULT_LABEL[r.kind], calc: r.calc, amount: Number(r.amount),
                     condition: r.condition, threshold: r.threshold === null || r.threshold === undefined ? null : Number(r.threshold) }));
}

module.exports = {
    KINDS, CALCS, CONDITIONS, DEFAULT_LABEL,
    normalizeFeeRule, ruleApplies, ruleAmount, legacyRules,
    resolveFees, feeLinesOf, loadFeeRules, groupIdForUser, publicRulesFor
};
