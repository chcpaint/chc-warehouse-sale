/**
 * routes/price-editor-admin.js
 *
 * Per-customer, per-item price editing, mounted from routes/admin.js at
 *   /api/admin/pricing
 *
 *   GET /companies                                  customers this account may price
 *   GET /companies/:companyId/products              that customer's catalogue, with lock flags
 *   PUT /companies/:companyId/products/:productId/price
 *
 * WHO. super_admin (any customer), a company-scoped admin (their own customer
 * only), and order_manager (any customer — the operations manager prices
 * across every account). order_desk is refused. Like delivery-fee-admin this
 * deliberately sits OUTSIDE requireCompanyAccess, which refuses order_desk and
 * has no path for an order_manager (no company_id of its own to match);
 * canEditPrices() below is the real gate, and restrictOrderDesk's allow-list
 * in middleware/auth.js names these three routes so the widening is visible.
 *
 * THE PPG LOCK. PPG prices are one list price on every customer, sourced from
 * the master table (item_library, brand "ppg", matched on sku_key) — the same
 * rule the catalogue upload applies. So here:
 *   - setting a PPG item to its master price is always fine (it re-syncs a
 *     drifted row);
 *   - setting it to anything else is refused (409 ppg_locked) unless the
 *     caller passes unlock_ppg AND is an admin who may make that exception
 *     (super_admin / company admin — the same people who can tick "Unlock PPG
 *     prices" on an upload). An order_manager cannot, whatever they send.
 *
 * SANITY. utils/price-rules.js priceVerdict() is the pre-submit warning;
 * migration 024's trigger is the enforcer. Below 15% of the library list price
 * is refused outright (422). 15–30% or above 4x is allowed but needs an
 * explicit confirm_outlier, and the trigger then records it in price_anomalies.
 *
 * FROZEN / CLOSED CATALOGUES. company_catalogue_policy governs what the MASTER
 * pushes into a customer. A person deliberately pricing one line is not a
 * push, so it is allowed on frozen and closed customers alike.
 *
 * previous_price is left alone: it drives the "was $X" strike-through shoppers
 * see, and a quiet re-price should not look like a sale. The change itself is
 * in the audit log (old and new price, who, why).
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { stripHtml, isValidUUID } = require('../utils/sanitize');
const { priceVerdict } = require('../utils/price-rules');

const router = express.Router();

const MAX_PRICE = 1000000;
const PRICE_EDIT_ROLES = ['super_admin', 'admin', 'order_manager'];
const PPG_UNLOCK_ROLES = ['super_admin', 'admin'];

function canEditPrices(admin) {
    return !!admin && PRICE_EDIT_ROLES.includes(admin.role);
}

function canUnlockPPG(admin) {
    return !!admin && PPG_UNLOCK_ROLES.includes(admin.role);
}

const skuKeyOf = v => String(v || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
const money = n => Math.round(Number(n) * 100) / 100;

async function logAction(adminId, action, entityType, entityId, details, ip) {
    try {
        await supabaseAdmin.from('audit_log').insert({
            admin_id: adminId, action, entity_type: entityType, entity_id: entityId,
            details, ip_address: ip
        });
    } catch (err) {
        console.error('Audit log write failed:', err);
    }
}

/** Role gate; a company-scoped admin is also fenced to their own customer. */
function requirePricingAccess(req, res, next) {
    if (!canEditPrices(req.admin)) {
        return res.status(403).json({ error: 'Your account cannot edit customer pricing.' });
    }
    const companyId = req.params.companyId;
    if (companyId && req.admin.role === 'admin' && req.admin.company_id !== companyId) {
        return res.status(403).json({ error: 'Access denied for this company.' });
    }
    next();
}

// Applied per route, not with router.use: req.params.companyId only exists once
// a route has matched, and the company-admin fence below depends on it.

/**
 * Library facts for a set of SKUs: reference list price, and whether the part
 * is a PPG one (and so locked). Keyed by sku_key.
 */
async function libraryFor(skus) {
    const keys = [...new Set(skus.map(skuKeyOf).filter(Boolean))];
    const out = new Map();
    for (let i = 0; i < keys.length; i += 200) {
        const { data } = await supabaseAdmin.from('item_library')
            .select('sku_key, list_price, brand')
            .in('sku_key', keys.slice(i, i + 200));
        for (const r of data || []) {
            out.set(r.sku_key, {
                list_price: Number(r.list_price) > 0 ? Number(r.list_price) : null,
                ppg: String(r.brand || '').trim().toLowerCase() === 'ppg'
            });
        }
    }
    return out;
}

// ---------------------------------------------------------------------------

router.get('/companies', requirePricingAccess, async (req, res) => {
    try {
        let query = supabaseAdmin.from('companies')
            .select('id, name, is_active').order('name');
        if (req.distributor) query = query.eq('distributor_id', req.distributor.id);
        if (req.admin.role === 'admin') query = query.eq('id', req.admin.company_id);

        const { data, error } = await query;
        if (error) throw error;
        res.json({ companies: data || [] });
    } catch (err) {
        console.error('Pricing companies error:', err);
        res.status(500).json({ error: 'Failed to load customers.' });
    }
});

router.get('/companies/:companyId/products', requirePricingAccess, async (req, res) => {
    try {
        const { companyId } = req.params;
        if (!isValidUUID(companyId)) return res.status(400).json({ error: 'Invalid company id.' });

        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
        // Keep the characters PostgREST's or() grammar treats as syntax out of
        // the search text, rather than trying to escape them.
        const q = stripHtml(String(req.query.q || '')).replace(/[,()*%\\]/g, ' ').trim();
        const brand = stripHtml(String(req.query.brand || '')).trim();

        let query = supabaseAdmin.from('products')
            .select('id, name, brand, sku, category, price, previous_price, price_on_request, case_qty, unit, is_active',
                    { count: 'exact' })
            .eq('company_id', companyId)
            .order('name')
            .range((page - 1) * limit, page * limit - 1);
        if (brand) query = query.eq('brand', brand);
        if (q) query = query.or(`name.ilike.%${q}%,sku.ilike.%${q}%`);

        const { data, error, count } = await query;
        if (error) throw error;

        const products = data || [];
        const lib = await libraryFor(products.map(p => p.sku));
        for (const p of products) {
            const l = lib.get(skuKeyOf(p.sku));
            p.list_price = l ? l.list_price : null;
            p.ppg_locked = !!(l && l.ppg && l.list_price);
            p.master_price = p.ppg_locked ? l.list_price : null;
        }

        res.json({
            products, total: count, page, limit,
            can_unlock_ppg: canUnlockPPG(req.admin)
        });
    } catch (err) {
        console.error('Pricing products error:', err);
        res.status(500).json({ error: 'Failed to load products.' });
    }
});

router.put('/companies/:companyId/products/:productId/price', requirePricingAccess, async (req, res) => {
    try {
        const { companyId, productId } = req.params;
        if (!isValidUUID(companyId) || !isValidUUID(productId)) {
            return res.status(400).json({ error: 'Invalid id.' });
        }

        const body = req.body || {};
        if (body.price === undefined || body.price === null || String(body.price).trim() === '') {
            return res.status(400).json({ error: 'Enter a price.' });
        }
        const price = Number(body.price);
        if (!Number.isFinite(price) || price <= 0 || price > MAX_PRICE) {
            return res.status(400).json({ error: `Price must be a number above 0 and no more than ${MAX_PRICE.toLocaleString('en-US')}.` });
        }
        const newPrice = money(price);
        const reason = stripHtml(String(body.reason || '')).trim().slice(0, 200);
        const unlockPPG = body.unlock_ppg === true;
        const confirmOutlier = body.confirm_outlier === true;

        const { data: product } = await supabaseAdmin.from('products')
            .select('id, company_id, name, sku, brand, price, price_on_request')
            .eq('id', productId).maybeSingle();
        if (!product || product.company_id !== companyId) {
            return res.status(404).json({ error: 'That product is not in this customer\'s catalogue.' });
        }

        const oldPrice = money(product.price);

        // Someone else changed this price since this screen loaded it.
        if (body.expected_price !== undefined && body.expected_price !== null) {
            if (Math.abs(money(body.expected_price) - oldPrice) > 0.004) {
                return res.status(409).json({
                    code: 'stale',
                    current_price: oldPrice,
                    error: `This price changed to $${oldPrice.toFixed(2)} while you were editing. Review it and try again.`
                });
            }
        }

        if (!product.price_on_request && Math.abs(newPrice - oldPrice) < 0.004) {
            return res.json({ product, unchanged: true, old_price: oldPrice, new_price: newPrice });
        }

        const lib = (await libraryFor([product.sku])).get(skuKeyOf(product.sku));
        const masterPrice = lib && lib.ppg && lib.list_price ? lib.list_price : null;

        // PPG: one list price everywhere.
        let ppgOverride = false;
        if (masterPrice !== null && Math.abs(newPrice - masterPrice) >= 0.004) {
            if (!unlockPPG) {
                return res.status(409).json({
                    code: 'ppg_locked',
                    master_price: masterPrice,
                    error: `PPG prices are one list price on every customer ($${masterPrice.toFixed(2)}). Set it to the list price, or have an admin unlock this item.`
                });
            }
            if (!canUnlockPPG(req.admin)) {
                return res.status(403).json({
                    code: 'ppg_unlock_denied',
                    master_price: masterPrice,
                    error: 'Only an admin can override a PPG list price.'
                });
            }
            ppgOverride = true;
        }

        const verdict = priceVerdict(newPrice, lib ? lib.list_price : null);
        if (verdict.action === 'refuse') {
            return res.status(422).json({ code: 'price_refused', ratio: verdict.ratio, error: verdict.message });
        }
        if (verdict.record && !confirmOutlier) {
            return res.status(409).json({
                code: 'needs_confirmation',
                ratio: verdict.ratio,
                list_price: lib ? lib.list_price : null,
                error: verdict.message
            });
        }

        const { data: updated, error } = await supabaseAdmin.from('products')
            .update({ price: newPrice, price_on_request: false, updated_at: new Date().toISOString() })
            .eq('id', productId).eq('company_id', companyId)
            .select('id, company_id, name, sku, brand, price, previous_price, price_on_request')
            .single();

        if (error) {
            // The database's own backstop (migration 024) said no.
            if (error.code === '23514' || /decimal error/i.test(error.message || '')) {
                return res.status(422).json({ code: 'price_refused', error: error.message });
            }
            throw error;
        }

        await logAction(req.admin.id, 'product_price_edited', 'product', productId, {
            company_id: companyId,
            sku: product.sku,
            name: product.name,
            old_price: oldPrice,
            new_price: newPrice,
            was_price_on_request: !!product.price_on_request,
            ppg_override: ppgOverride,
            outlier_confirmed: !!(verdict.record && confirmOutlier),
            reason: reason || null
        }, req.ip);

        res.json({
            product: updated,
            old_price: oldPrice,
            new_price: newPrice,
            warning: verdict.record ? verdict.message : null
        });
    } catch (err) {
        console.error('Price edit error:', err);
        res.status(500).json({ error: 'Failed to save the price.' });
    }
});

module.exports = router;
module.exports.canEditPrices = canEditPrices;
module.exports.canUnlockPPG = canUnlockPPG;
