/**
 * routes/billing-admin.js
 *
 * A distributor's billing console, mounted from routes/admin.js at
 *   /api/admin/billing
 *
 * The distributor decides which of its customers pay. Per company:
 *   mode 'free'  - everything switched on keeps working, no charge (the default).
 *   mode 'paid'  - the optional modules only work for items the customer has
 *                  subscribed to, or that a super admin has given them free ($0).
 * The distributor also sets its own prices (defaults come from utils/billing.js).
 * The sales portal (ordering) is always free and not part of any of this.
 *
 * Super admin only -- this decides what customers are charged and who is let
 * off. Every change is written to the audit log with the reason where one is
 * required. A super admin can only touch companies of their own distributor.
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requireSuperAdmin } = require('../middleware/auth');
const { distributorTax } = require('../utils/tax');
const { moduleSettings, MODULE_NAMES } = require('../utils/modules');
const B = require('../utils/billing');
const db = require('../utils/billing-db');

const router = express.Router();
router.use(requireSuperAdmin);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function logAction(adminId, action, entityId, details, ip) {
    try {
        await supabaseAdmin.from('audit_log').insert({
            admin_id: adminId, action, entity_type: 'billing', entity_id: entityId, details, ip_address: ip
        });
    } catch (err) { console.error('Audit log write failed:', err); }
}

function distributorIdOf(req) { return req.admin?.distributor_id || req.distributor?.id || null; }

async function loadDistributor(id) {
    const { data, error } = await supabaseAdmin.from('distributors')
        .select('id, name, settings, stripe_account_id, stripe_connect_status').eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
}

/** The company, only if it belongs to this admin's distributor. */
async function loadOwnCompany(req, companyId) {
    if (!UUID.test(String(companyId || ''))) return null;
    const { data } = await supabaseAdmin.from('companies')
        .select('id, name, slug, settings, distributor_id, is_active').eq('id', companyId).maybeSingle();
    if (!data) return null;
    const mine = distributorIdOf(req);
    if (mine && data.distributor_id && data.distributor_id !== mine) return null;
    return data;
}

function catalogView(prices) {
    return B.ITEM_KEYS.map(k => ({
        item: k, label: B.ITEMS[k].label, blurb: B.ITEMS[k].blurb, unit: B.ITEMS[k].unit, bundle: B.ITEMS[k].bundle || null,
        month_cents: prices[k].month, year_cents: prices[k].year, currency: prices[k].currency,
        month_overridden: prices[k].overridden.month, year_overridden: prices[k].overridden.year,
        default_month_cents: B.defaultPrice(k, 'month'), default_year_cents: B.defaultPrice(k, 'year')
    }));
}

/** GET /prices -- the price list customers see, with what has been overridden. */
router.get('/prices', async (req, res) => {
    try {
        const did = distributorIdOf(req);
        const dist = await loadDistributor(did);
        if (!dist) return res.status(404).json({ error: 'Distributor not found.' });
        const country = distributorTax(dist.settings)?.country || 'CA';
        const prices = B.resolvePrices(await db.loadPrices(supabaseAdmin, did), did, country);
        res.json({
            currency: B.currencyFor(country), items: catalogView(prices),
            stripe: { connected: dist.stripe_connect_status === 'active', status: dist.stripe_connect_status }
        });
    } catch (err) {
        console.error('Billing prices read error:', err);
        res.status(500).json({ error: 'Failed to load prices.' });
    }
});

/**
 * PUT /prices   Body: { item, interval, amount }
 * `amount` is dollars (0 allowed = free). null/'' clears the override and goes
 * back to the default.
 */
router.put('/prices', async (req, res) => {
    try {
        const { item, interval, amount } = req.body || {};
        if (!B.ITEMS[item]) return res.status(400).json({ error: 'Unknown item.' });
        if (!B.INTERVALS.includes(interval)) return res.status(400).json({ error: 'Interval must be month or year.' });
        const did = distributorIdOf(req);
        if (!did) return res.status(400).json({ error: 'No distributor for this account.' });

        if (amount === null || amount === undefined || amount === '') {
            const { error } = await supabaseAdmin.from('billing_prices').delete()
                .eq('distributor_id', did).eq('item', item).eq('interval', interval);
            if (error) throw error;
            await logAction(req.admin.id, 'billing_price_reset', did, { item, interval }, req.ip);
            return res.json({ message: 'Back to the standard price.' });
        }
        const dollars = Number(amount);
        if (!Number.isFinite(dollars) || dollars < 0 || dollars > 1000000) {
            return res.status(400).json({ error: 'Price must be a dollar amount of 0 or more.' });
        }
        const cents = Math.round(dollars * 100);
        const dist = await loadDistributor(did);
        const currency = B.currencyFor(distributorTax(dist?.settings)?.country || 'CA');
        const { error } = await supabaseAdmin.from('billing_prices').upsert({
            distributor_id: did, item, interval, unit_amount_cents: cents, currency, updated_by: req.admin.id,
            updated_at: new Date().toISOString()
        }, { onConflict: 'distributor_id,item,interval' });
        if (error) throw error;
        await logAction(req.admin.id, 'billing_price_set', did, { item, interval, cents }, req.ip);
        res.json({ message: `${B.ITEMS[item].label} is now ${B.formatMoney(cents, currency)} per ${interval === 'year' ? 'year' : 'month'}.`, item, interval, unit_amount_cents: cents });
    } catch (err) {
        console.error('Billing price write error:', err);
        res.status(500).json({ error: 'Failed to save the price.' });
    }
});

/** GET /companies -- every customer: free or paid, what they have, what they pay. */
router.get('/companies', async (req, res) => {
    try {
        const did = distributorIdOf(req);
        let q = supabaseAdmin.from('companies').select('id, name, slug, settings, is_active, distributor_id').order('name');
        if (did) q = q.eq('distributor_id', did);
        const { data: companies, error } = await q;
        if (error) throw error;
        const ids = (companies || []).map(c => c.id);
        let rows = [];
        if (ids.length) {
            const r = await supabaseAdmin.from('company_entitlements').select('*').in('company_id', ids);
            if (r.error) throw r.error;
            rows = r.data || [];
        }
        let mrr = 0;
        const out = (companies || []).map(c => {
            const mine = rows.filter(r => r.company_id === c.id);
            const cfg = B.billingConfig(c.settings);
            const paying = B.activeRows(mine).filter(r => r.source === 'paid');
            const monthly = paying.reduce((s, r) => s + B.monthlyCents(r.unit_amount_cents * r.quantity, r.interval), 0);
            mrr += monthly;
            return {
                id: c.id, name: c.name, slug: c.slug, is_active: c.is_active, mode: cfg.mode, entitled: cfg.entitled,
                items: mine.map(r => ({
                    item: r.item, status: r.status, source: r.source, interval: r.interval, quantity: r.quantity,
                    unit_amount_cents: r.unit_amount_cents, currency: r.currency, comp_reason: r.comp_reason,
                    comp_until: r.comp_until, current_period_end: r.current_period_end, cancel_at_period_end: r.cancel_at_period_end
                })),
                monthly_cents: monthly
            };
        });
        res.json({
            companies: out,
            summary: {
                paid_companies: out.filter(c => c.mode === 'paid').length,
                free_companies: out.filter(c => c.mode === 'free').length,
                comped_items: rows.filter(r => r.source === 'comp').length,
                mrr_cents: mrr, arr_cents: mrr * 12
            }
        });
    } catch (err) {
        console.error('Billing companies error:', err);
        res.status(500).json({ error: 'Failed to load customers.' });
    }
});

/** Optional modules a company has switched on that billing would lock. */
function lockedModules(company) {
    const asPaid = { ...(company.settings || {}), billing: { mode: 'paid', entitled: [] } };
    return MODULE_NAMES.filter(n => B.itemForModule(n)
        && moduleSettings(company.settings, n).enabled && !moduleSettings(asPaid, n).enabled);
}

/**
 * PUT /companies/:companyId/mode   Body: { mode: 'free'|'paid', grandfather?, confirm? }
 *
 * Moving a customer to paid would switch off anything optional they use today.
 * So the first call says what would stop (409); the caller then either asks to
 * give those items to the customer free (grandfather) or confirms they should stop.
 */
router.put('/companies/:companyId/mode', async (req, res) => {
    try {
        const company = await loadOwnCompany(req, req.params.companyId);
        if (!company) return res.status(404).json({ error: 'Company not found.' });
        const mode = req.body?.mode;
        if (!['free', 'paid'].includes(mode)) return res.status(400).json({ error: 'Mode must be free or paid.' });

        if (mode === 'paid') {
            const cfg = B.billingConfig(company.settings);
            const locked = cfg.mode === 'paid' ? [] : lockedModules(company);
            if (locked.length && !req.body.grandfather && !req.body.confirm) {
                return res.status(409).json({
                    error: `${company.name} uses ${locked.join(', ')} today. Moving them to paid switches these off unless they subscribe or you give them free.`,
                    affected_modules: locked
                });
            }
            if (locked.length && req.body.grandfather) {
                const items = [...new Set(locked.map(B.itemForModule))];
                await db.grantComp(supabaseAdmin, {
                    company, items, reason: 'Kept free when billing was switched on', adminId: req.admin.id
                });
            }
        }

        const fresh = await supabaseAdmin.from('companies').select('settings').eq('id', company.id).maybeSingle();
        const base = fresh.data?.settings || company.settings || {};
        const settings = { ...base, billing: { ...(base.billing || {}), mode, entitled: B.billingConfig(base).entitled } };
        const { error } = await supabaseAdmin.from('companies').update({ settings, updated_at: new Date().toISOString() }).eq('id', company.id);
        if (error) throw error;
        await db.syncEntitlements(supabaseAdmin, company.id);
        await logAction(req.admin.id, 'billing_mode_set', company.id, { mode, grandfather: !!req.body.grandfather }, req.ip);
        res.json({ message: mode === 'paid' ? `${company.name} now pays for the optional parts.` : `${company.name} is free — nothing is charged.`, mode });
    } catch (err) {
        console.error('Billing mode error:', err);
        res.status(500).json({ error: 'Failed to change billing.' });
    }
});

/** POST /companies/:companyId/comp   Body: { items, reason, until? } -- $0 grant. */
router.post('/companies/:companyId/comp', async (req, res) => {
    try {
        const company = await loadOwnCompany(req, req.params.companyId);
        if (!company) return res.status(404).json({ error: 'Company not found.' });
        const items = [...new Set((req.body?.items || []).filter(k => B.ITEMS[k]))];
        if (!items.length) return res.status(400).json({ error: 'Choose at least one item.' });
        const reason = String(req.body?.reason || '').trim();
        if (reason.length < 3) return res.status(400).json({ error: 'Give a short reason — it is kept in the audit log.' });
        let until = null;
        if (req.body?.until) {
            const d = new Date(req.body.until);
            if (isNaN(d.getTime()) || d.getTime() < Date.now()) return res.status(400).json({ error: 'The end date must be in the future.' });
            until = d.toISOString();
        }
        const result = await db.grantComp(supabaseAdmin, { company, items, reason: reason.slice(0, 300), until, adminId: req.admin.id });
        await logAction(req.admin.id, 'billing_comp_granted', company.id, { ...result, reason: reason.slice(0, 300), until }, req.ip);
        res.json({
            message: result.granted.length ? `${company.name} has ${result.granted.map(k => B.ITEMS[k].label).join(', ')} free of charge.` : 'Nothing changed.',
            ...result,
            note: result.skipped.length ? 'Skipped items they already pay for — they need to cancel those first.' : undefined
        });
    } catch (err) {
        console.error('Billing comp error:', err);
        res.status(500).json({ error: 'Failed to give it free.' });
    }
});

/** DELETE /companies/:companyId/comp/:item -- take a free grant away. */
router.delete('/companies/:companyId/comp/:item', async (req, res) => {
    try {
        const company = await loadOwnCompany(req, req.params.companyId);
        if (!company) return res.status(404).json({ error: 'Company not found.' });
        if (!B.ITEMS[req.params.item]) return res.status(400).json({ error: 'Unknown item.' });
        const n = await db.revokeComp(supabaseAdmin, company.id, req.params.item);
        if (!n) return res.status(404).json({ error: 'There is no free grant for that item.' });
        await logAction(req.admin.id, 'billing_comp_revoked', company.id, { item: req.params.item }, req.ip);
        res.json({ message: `${B.ITEMS[req.params.item].label} is no longer free for ${company.name}.` });
    } catch (err) {
        console.error('Billing revoke error:', err);
        res.status(500).json({ error: 'Failed to remove the free grant.' });
    }
});

module.exports = router;
