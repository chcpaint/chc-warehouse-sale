/**
 * utils/billing-db.js
 *
 * Database side of billing: price list, entitlements, and keeping the cached
 * entitled list on companies.settings.billing in step with them (which is what
 * utils/modules.js reads). Rules live in utils/billing.js.
 */

const { ITEMS, ITEM_KEYS, expand, activeRows, entitledItems, withEntitled } = require('./billing');

const STRIPE_STATUS = {
    active: 'active', trialing: 'trialing', past_due: 'past_due', unpaid: 'unpaid',
    canceled: 'canceled', incomplete_expired: 'canceled', paused: 'canceled'
};

async function loadPrices(supabase, distributorId) {
    const platform = await supabase.from('billing_prices').select('*').is('distributor_id', null);
    if (platform.error) throw platform.error;
    let own = { data: [] };
    if (distributorId) {
        own = await supabase.from('billing_prices').select('*').eq('distributor_id', distributorId);
        if (own.error) throw own.error;
    }
    return [...(platform.data || []), ...(own.data || [])];
}

async function loadEntitlements(supabase, companyId) {
    const { data, error } = await supabase.from('company_entitlements').select('*').eq('company_id', companyId);
    if (error) throw error;
    return data || [];
}

/** Recompute and store settings.billing.entitled for one company. */
async function syncEntitlements(supabase, companyId) {
    const { data: company, error } = await supabase.from('companies').select('id, settings').eq('id', companyId).maybeSingle();
    if (error) throw error;
    if (!company) return null;
    const rows = await loadEntitlements(supabase, companyId);
    const settings = withEntitled(company.settings, rows);
    const { error: upErr } = await supabase.from('companies')
        .update({ settings, updated_at: new Date().toISOString() }).eq('id', companyId);
    if (upErr) throw upErr;
    return { settings, entitled: settings.billing.entitled, rows };
}

/**
 * $0 grant by a distributor super admin. Never overwrites something the
 * customer is actually paying for -- that has to be cancelled by them first.
 * @returns {{granted: string[], skipped: string[]}}
 */
async function grantComp(supabase, { company, items, reason, until, adminId }) {
    const existing = await loadEntitlements(supabase, company.id);
    const granted = [], skipped = [];
    for (const item of items) {
        const row = existing.find(r => r.item === item);
        if (row && row.source === 'paid' && activeRows([row]).length) { skipped.push(item); continue; }
        const { error } = await supabase.from('company_entitlements').upsert({
            company_id: company.id, distributor_id: company.distributor_id || null, item,
            status: 'comped', source: 'comp', interval: null, quantity: 1, unit_amount_cents: 0,
            comp_reason: reason, comp_until: until || null, granted_by: adminId || null,
            stripe_subscription_id: null, stripe_customer_id: row?.stripe_customer_id || null,
            current_period_end: null, cancel_at_period_end: false, updated_at: new Date().toISOString()
        }, { onConflict: 'company_id,item' });
        if (error) throw error;
        granted.push(item);
    }
    await syncEntitlements(supabase, company.id);
    return { granted, skipped };
}

async function revokeComp(supabase, companyId, item) {
    const { data, error } = await supabase.from('company_entitlements')
        .delete().eq('company_id', companyId).eq('item', item).eq('source', 'comp').select('id');
    if (error) throw error;
    await syncEntitlements(supabase, companyId);
    return (data || []).length;
}

/** Record items bought through Stripe (called from the webhook). */
async function applyPaidItems(supabase, { company, lines, interval, currency, customerId, subscriptionId }) {
    for (const l of lines) {
        const { error } = await supabase.from('company_entitlements').upsert({
            company_id: company.id, distributor_id: company.distributor_id || null, item: l.item,
            status: 'active', source: 'paid', interval, quantity: l.quantity, unit_amount_cents: l.unit_amount_cents,
            currency, stripe_customer_id: customerId || null, stripe_subscription_id: subscriptionId || null,
            comp_reason: null, comp_until: null, cancel_at_period_end: false, updated_at: new Date().toISOString()
        }, { onConflict: 'company_id,item' });
        if (error) throw error;
    }
    await syncEntitlements(supabase, company.id);
}

/** Free-priced items: the distributor set the price to $0, so nothing to pay. */
async function applyFreePriced(supabase, { company, lines, interval, currency }) {
    for (const l of lines) {
        const { error } = await supabase.from('company_entitlements').upsert({
            company_id: company.id, distributor_id: company.distributor_id || null, item: l.item,
            status: 'active', source: 'free_price', interval, quantity: l.quantity, unit_amount_cents: 0, currency,
            comp_reason: null, comp_until: null, updated_at: new Date().toISOString()
        }, { onConflict: 'company_id,item' });
        if (error) throw error;
    }
    await syncEntitlements(supabase, company.id);
}

/** A Stripe subscription changed state: update every item it carries. */
async function applySubscriptionUpdate(supabase, sub) {
    const status = STRIPE_STATUS[sub.status];
    if (!status) return 0;
    const { data: rows, error } = await supabase.from('company_entitlements')
        .select('id, company_id').eq('stripe_subscription_id', sub.id);
    if (error) throw error;
    if (!rows || !rows.length) return 0;
    const patch = {
        status, cancel_at_period_end: !!sub.cancel_at_period_end, updated_at: new Date().toISOString(),
        current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null
    };
    const { error: upErr } = await supabase.from('company_entitlements').update(patch).eq('stripe_subscription_id', sub.id);
    if (upErr) throw upErr;
    for (const cid of [...new Set(rows.map(r => r.company_id))]) await syncEntitlements(supabase, cid);
    return rows.length;
}

async function eventSeen(supabase, event) {
    const { data, error } = await supabase.from('billing_events').select('stripe_event_id').eq('stripe_event_id', event.id).maybeSingle();
    if (error) throw error;
    return !!data;
}

/** Marks an event as handled. Called only AFTER it was applied, so a failure part-way is retried by Stripe. */
async function recordEvent(supabase, event) {
    const { error } = await supabase.from('billing_events').insert({ stripe_event_id: event.id, type: event.type });
    if (error && !(error.code === '23505' || /duplicate/i.test(error.message || ''))) throw error;
}

/** Parse "inventory:3:12900,people:1:3900" (kept short: Stripe metadata values are limited). */
function parseLines(str) {
    const out = [];
    for (const part of String(str || '').split(',')) {
        const [item, q, a] = part.split(':');
        if (ITEMS[item] && Number(q) >= 1 && Number(a) >= 0) out.push({ item, quantity: Number(q), unit_amount_cents: Number(a) });
    }
    return out;
}
function encodeLines(lines) { return lines.map(l => `${l.item}:${l.quantity}:${l.unit_amount_cents}`).join(','); }

async function handleStripeEvent(supabase, event) {
    if (await eventSeen(supabase, event)) return { handled: false, duplicate: true };
    const result = await applyEvent(supabase, event);
    await recordEvent(supabase, event);
    return result;
}

async function applyEvent(supabase, event) {
    if (event.type === 'checkout.session.completed') {
        const s = event.data.object;
        if (s.mode !== 'subscription' || s.metadata?.kind !== 'console_subscription') return { handled: false };
        if (!['paid', 'no_payment_required'].includes(s.payment_status)) return { handled: false, reason: 'unpaid' };
        const { data: company } = await supabase.from('companies')
            .select('id, distributor_id, settings').eq('id', s.metadata.company_id).maybeSingle();
        // The metadata is ours, but never trust it further than the database agrees.
        if (!company || (s.metadata.distributor_id && company.distributor_id !== s.metadata.distributor_id)) {
            return { handled: false, reason: 'company mismatch' };
        }
        const lines = parseLines(s.metadata.lines);
        if (!lines.length) return { handled: false, reason: 'no lines' };
        await applyPaidItems(supabase, {
            company, lines, interval: s.metadata.interval === 'year' ? 'year' : 'month',
            currency: s.currency === 'usd' ? 'usd' : 'cad', customerId: s.customer, subscriptionId: s.subscription
        });
        return { handled: true, items: lines.map(l => l.item) };
    }
    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted'
        || event.type === 'customer.subscription.created') {
        const n = await applySubscriptionUpdate(supabase, event.data.object);
        return { handled: n > 0, rows: n };
    }
    return { handled: false };
}

module.exports = {
    loadPrices, loadEntitlements, syncEntitlements, grantComp, revokeComp,
    applyPaidItems, applyFreePriced, applySubscriptionUpdate, recordEvent,
    handleStripeEvent, parseLines, encodeLines, STRIPE_STATUS
};
