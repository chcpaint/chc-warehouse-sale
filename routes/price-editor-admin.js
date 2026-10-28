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
 * BULK. POST /companies/:companyId/bulk applies a percent change to a group of
 * ONE customer's items: a brand, a category, a search ("EHP", "toner"), a set of
 * ticked items, or (explicitly) the whole catalogue. It is two-step on purpose:
 * apply:false returns a preview (counts, before/after sample, what was skipped
 * and why) and writes nothing; apply:true recomputes everything server-side —
 * never trusting figures from the browser — and refuses with 409 scope_changed
 * if the number of items that would change is not the number the manager was
 * shown. The same rules as a single edit run per item: PPG items are skipped
 * unless include_ppg (admins only), prices outside the sanity band are skipped
 * unless include_outliers, refused prices are always skipped, and a row edited
 * by someone else mid-run is left alone rather than overwritten.
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
const PRICE_EDIT_ROLES = ['super_admin', 'admin', 'order_manager', 'sales_director'];
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
// Scope: the same three filters as the storefront's sales screen — free-text
// search (name, SKU or brand), brand, category — plus an explicit list of
// ticked items.

const MAX_BULK_ITEMS = 10000;
const MAX_SELECTED_IDS = 5000;
const MIN_PERCENT = -90;
const MAX_PERCENT = 200;
const SAMPLE_ROWS = 100;
const AUDIT_ITEM_CAP = 5000;

function cleanSearch(v) {
    // Keep the characters PostgREST's or() grammar treats as syntax out of the
    // search text rather than trying to escape them.
    return stripHtml(String(v || '')).replace(/[,()*%\\]/g, ' ').trim();
}

function parseScope(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const scope = {
        brand: stripHtml(String(r.brand || '')).trim(),
        category: stripHtml(String(r.category || '')).trim(),
        search: cleanSearch(r.search),
        product_ids: Array.isArray(r.product_ids)
            ? [...new Set(r.product_ids.filter(isValidUUID))].slice(0, MAX_SELECTED_IDS) : []
    };
    scope.narrowed = !!(scope.brand || scope.category || scope.search || scope.product_ids.length);
    return scope;
}

function applyScope(query, scope) {
    if (scope.brand) query = query.eq('brand', scope.brand);
    if (scope.category) query = query.eq('category', scope.category);
    if (scope.search) {
        query = query.or(`name.ilike.%${scope.search}%,sku.ilike.%${scope.search}%,brand.ilike.%${scope.search}%`);
    }
    return query;
}

/** Every product matching the scope (paged past PostgREST's row cap). */
async function fetchScoped(companyId, scope) {
    const cols = 'id, name, brand, sku, category, price, price_on_request, is_active';
    const out = [];
    const idChunks = scope.product_ids.length
        ? Array.from({ length: Math.ceil(scope.product_ids.length / 200) }, (_, i) => scope.product_ids.slice(i * 200, i * 200 + 200))
        : [null];
    for (const ids of idChunks) {
        for (let from = 0; ; from += 1000) {
            let q = supabaseAdmin.from('products').select(cols)
                .eq('company_id', companyId).order('name').range(from, from + 999);
            q = applyScope(q, scope);
            if (ids) q = q.in('id', ids);
            const { data, error } = await q;
            if (error) throw error;
            out.push(...(data || []));
            if ((data || []).length < 1000) break;
            if (out.length > MAX_BULK_ITEMS) return out;
        }
    }
    return out;
}

/** new price = old * (1 + pct/100), to the cent. */
function applyPercent(oldPrice, pct) {
    return Math.round(Number(oldPrice) * (100 + pct) + 1e-9) / 100;
}

/**
 * Decide what a percent change would do to each product. Pure: no database,
 * no request — which is what lets the preview and the apply share it exactly.
 *
 * lib: Map sku_key -> { list_price, ppg }, as returned by libraryFor().
 */
function planBulk(products, lib, pct, opts) {
    const o = opts || {};
    const changes = [];
    const skipped = { ppg_locked: 0, price_on_request: 0, refused: 0, outlier: 0, unchanged: 0, invalid: 0 };
    let ppgIncluded = 0, outliersIncluded = 0;

    for (const p of products) {
        if (p.price_on_request) { skipped.price_on_request++; continue; }
        const oldP = money(p.price);
        if (!Number.isFinite(oldP) || oldP <= 0) { skipped.invalid++; continue; }
        const newP = applyPercent(oldP, pct);
        if (!Number.isFinite(newP) || newP <= 0 || newP > MAX_PRICE) { skipped.invalid++; continue; }
        if (Math.abs(newP - oldP) < 0.004) { skipped.unchanged++; continue; }

        const l = lib.get(skuKeyOf(p.sku));
        const master = l && l.ppg && l.list_price ? l.list_price : null;
        let ppgOverride = false;
        if (master !== null && Math.abs(newP - master) >= 0.004) {
            if (!o.includePPG) { skipped.ppg_locked++; continue; }
            ppgOverride = true;
        }

        const v = priceVerdict(newP, l ? l.list_price : null);
        if (v.action === 'refuse') { skipped.refused++; continue; }
        if (v.record && !o.includeOutliers) { skipped.outlier++; continue; }

        if (ppgOverride) ppgIncluded++;
        if (v.record) outliersIncluded++;
        changes.push({
            id: p.id, sku: p.sku, name: p.name, brand: p.brand,
            old_price: oldP, new_price: newP, ppg_override: ppgOverride, outlier: !!v.record
        });
    }
    return { changes, skipped, ppgIncluded, outliersIncluded };
}

/** Run fn over items with a small fixed concurrency. */
async function mapLimit(items, limit, fn) {
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
    });
    await Promise.all(workers);
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

/**
 * Brand and category choices for this customer's catalogue — what the sales
 * screen offers in its two dropdowns. Hidden items are included: this screen
 * prices the whole catalogue, not just what shoppers can currently see.
 */
router.get('/companies/:companyId/filters', requirePricingAccess, async (req, res) => {
    try {
        const { companyId } = req.params;
        if (!isValidUUID(companyId)) return res.status(400).json({ error: 'Invalid company id.' });

        const brands = new Set(), categories = new Set();
        for (let from = 0; ; from += 1000) {
            const { data, error } = await supabaseAdmin.from('products')
                .select('brand, category').eq('company_id', companyId)
                .order('brand').range(from, from + 999);
            if (error) throw error;
            for (const r of data || []) {
                if (r.brand) brands.add(r.brand);
                if (r.category) categories.add(r.category);
            }
            if ((data || []).length < 1000) break;
        }
        const sort = a => [...a].sort((x, y) => String(x).localeCompare(String(y)));
        res.json({ brands: sort(brands), categories: sort(categories) });
    } catch (err) {
        console.error('Pricing filters error:', err);
        res.status(500).json({ error: 'Failed to load filters.' });
    }
});

router.get('/companies/:companyId/products', requirePricingAccess, async (req, res) => {
    try {
        const { companyId } = req.params;
        if (!isValidUUID(companyId)) return res.status(400).json({ error: 'Invalid company id.' });

        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
        const scope = parseScope({
            // `q` is the original name for the search box; the sales screen calls it `search`.
            search: req.query.search !== undefined ? req.query.search : req.query.q,
            brand: req.query.brand,
            category: req.query.category
        });

        let query = supabaseAdmin.from('products')
            .select('id, name, brand, sku, category, price, previous_price, price_on_request, case_qty, unit, is_active',
                    { count: 'exact' })
            .eq('company_id', companyId)
            .order('brand').order('name')
            .range((page - 1) * limit, page * limit - 1);
        query = applyScope(query, scope);

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

/**
 * POST /api/admin/pricing/companies/:companyId/bulk
 *
 * Body: {
 *   percent,                         // e.g. 3 for +3%, -5 for -5%
 *   scope: { brand?, category?, search?, product_ids? },
 *   all_items?: true,                // required when scope narrows nothing
 *   include_ppg?, include_outliers?, // see the header
 *   apply?: true,                    // omit for a preview
 *   expected_count?,                 // the changed-item count the manager was shown
 *   reason?
 * }
 */
router.post('/companies/:companyId/bulk', requirePricingAccess, async (req, res) => {
    try {
        const { companyId } = req.params;
        if (!isValidUUID(companyId)) return res.status(400).json({ error: 'Invalid company id.' });

        const body = req.body || {};
        const pct = Number(body.percent);
        if (body.percent === undefined || body.percent === null || String(body.percent).trim() === '' || !Number.isFinite(pct) || pct === 0) {
            return res.status(400).json({ error: 'Enter a percentage to change prices by (for example 3, or -5).' });
        }
        if (pct < MIN_PERCENT || pct > MAX_PERCENT) {
            return res.status(400).json({ error: `A bulk change must be between ${MIN_PERCENT}% and +${MAX_PERCENT}%.` });
        }
        const percent = Math.round(pct * 100) / 100;

        const scope = parseScope(body.scope);
        if (!scope.narrowed && body.all_items !== true) {
            return res.status(400).json({ error: 'Choose a brand, a category, a search, or tick items first — or confirm you mean every item.' });
        }

        const includePPG = body.include_ppg === true;
        if (includePPG && !canUnlockPPG(req.admin)) {
            return res.status(403).json({ code: 'ppg_unlock_denied', error: 'Only an admin can override PPG list prices.' });
        }
        const includeOutliers = body.include_outliers === true;
        const apply = body.apply === true;
        const reason = stripHtml(String(body.reason || '')).trim().slice(0, 200);

        const { data: company } = await supabaseAdmin.from('companies')
            .select('id, name').eq('id', companyId).maybeSingle();
        if (!company) return res.status(404).json({ error: 'Customer not found.' });

        const products = await fetchScoped(companyId, scope);
        if (products.length > MAX_BULK_ITEMS) {
            return res.status(400).json({ error: `That matches more than ${MAX_BULK_ITEMS.toLocaleString('en-US')} items. Narrow it by brand or category.` });
        }

        const lib = await libraryFor(products.map(p => p.sku));
        const plan = planBulk(products, lib, percent, { includePPG, includeOutliers });
        const changes = plan.changes;

        const summary = {
            company: { id: company.id, name: company.name },
            percent,
            matched: products.length,
            will_change: changes.length,
            skipped: plan.skipped,
            ppg_included: plan.ppgIncluded,
            outliers_included: plan.outliersIncluded,
            total_before: money(changes.reduce((t, c) => t + c.old_price, 0)),
            total_after: money(changes.reduce((t, c) => t + c.new_price, 0)),
            can_unlock_ppg: canUnlockPPG(req.admin)
        };

        if (!apply) {
            return res.json({ preview: true, ...summary, sample: changes.slice(0, SAMPLE_ROWS) });
        }

        // The manager confirmed a specific number of items. If the catalogue (or
        // anyone's price) moved since, what would happen now is not what they
        // agreed to — show them again rather than apply something different.
        if (Number(body.expected_count) !== changes.length) {
            return res.status(409).json({
                code: 'scope_changed',
                error: `This would now change ${changes.length} item${changes.length === 1 ? '' : 's'}, not ${Number(body.expected_count) || 0}. Review it again.`,
                ...summary, sample: changes.slice(0, SAMPLE_ROWS)
            });
        }
        if (!changes.length) {
            return res.json({ applied: true, changed: 0, failed: 0, changed_meanwhile: 0, refused_by_database: 0, ...summary });
        }

        const now = new Date().toISOString();
        const done = [];
        let failed = 0, changedMeanwhile = 0, refusedByDb = 0;

        await mapLimit(changes, 8, async (c) => {
            // The price is part of the match: a row someone else repriced after
            // the preview is left exactly as they set it.
            const { data, error } = await supabaseAdmin.from('products')
                .update({ price: c.new_price, price_on_request: false, updated_at: now })
                .eq('id', c.id).eq('company_id', companyId).eq('price', c.old_price)
                .select('id');
            if (error) {
                if (error.code === '23514' || /decimal error/i.test(error.message || '')) refusedByDb++;
                else { failed++; console.error('Bulk price update failed for', c.id, error); }
                return;
            }
            if (!data || !data.length) { changedMeanwhile++; return; }
            done.push(c);
        });

        await logAction(req.admin.id, 'product_prices_bulk_changed', 'company', companyId, {
            company_name: company.name,
            percent,
            scope: { brand: scope.brand || null, category: scope.category || null, search: scope.search || null,
                     selected_items: scope.product_ids.length || null, all_items: !scope.narrowed },
            matched: products.length,
            changed: done.length,
            skipped: plan.skipped,
            failed, changed_meanwhile: changedMeanwhile, refused_by_database: refusedByDb,
            ppg_override_items: done.filter(c => c.ppg_override).length,
            outlier_items: done.filter(c => c.outlier).length,
            reason: reason || null,
            // Enough to put every price back: id, sku, old and new.
            items: done.slice(0, AUDIT_ITEM_CAP).map(c => ({ id: c.id, sku: c.sku, old: c.old_price, new: c.new_price })),
            items_truncated: done.length > AUDIT_ITEM_CAP
        }, req.ip);

        res.json({
            applied: true, changed: done.length, failed,
            changed_meanwhile: changedMeanwhile, refused_by_database: refusedByDb,
            ...summary
        });
    } catch (err) {
        console.error('Bulk price error:', err);
        res.status(500).json({ error: 'Failed to apply the price change.' });
    }
});

module.exports = router;
module.exports.canEditPrices = canEditPrices;
module.exports.canUnlockPPG = canUnlockPPG;
module.exports.planBulk = planBulk;
module.exports.applyPercent = applyPercent;
