/**
 * routes/inventory-store.js
 *
 * refinishAI Inventory — shop-floor API, mounted from routes/storefront.js at
 *   /api/store/:slug/inventory
 *
 * Mounted as a sub-router (mergeParams) so no change to server.js is needed.
 * Every route re-applies requireCompanyAuth rather than relying on the parent,
 * so the file is safe to remount anywhere.
 *
 * Storefront sessions authenticate with a company access code and carry no user
 * identity, so every write takes an `actor_label` (the staff member's name or
 * initials) which is stored on the ledger row. That is what gives the audit
 * trail its "who".
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requireCompanyAuth } = require('../middleware/auth');
const { stripHtml, isValidUUID } = require('../utils/sanitize');
const { resolveOrderRecipients } = require('../utils/recipients');
const { sendOrderNotification } = require('../utils/email');
const {
    STORE_MOVEMENT_TYPES,
    MOVEMENT_TYPES,
    barcodeVariants,
    canonicalBarcode,
    movementDelta,
    replenishmentFor,
    inventorySettings
} = require('../utils/inventory');

const router = express.Router({ mergeParams: true });

router.use(requireCompanyAuth);

// ============================================================
// GUARDS
// ============================================================

/**
 * Inventory is opt-in per company. Load the settings block once per request and
 * refuse cleanly when the company has not enabled the module.
 */
async function requireInventoryEnabled(req, res, next) {
    try {
        const { data: company, error } = await supabaseAdmin
            .from('companies')
            .select('id, name, settings')
            .eq('id', req.company.id)
            .single();

        if (error || !company) return res.status(404).json({ error: 'Company not found.' });

        const settings = inventorySettings(company.settings);
        if (!settings.enabled) {
            return res.status(403).json({ error: 'refinishAI Inventory is not enabled for this account.' });
        }

        req.inventorySettings = settings;
        next();
    } catch (err) {
        console.error('Inventory settings error:', err);
        res.status(500).json({ error: 'Failed to load inventory settings.' });
    }
}

router.use(requireInventoryEnabled);

/**
 * Resolve a location id to a real, active location belonging to this company.
 * Never trust a client-supplied location.
 */
async function resolveLocation(companyId, locationId) {
    if (!locationId || !isValidUUID(locationId)) return null;
    const { data } = await supabaseAdmin
        .from('company_locations')
        .select('id, name, city, supplier_branch_id, restrict_to_category')
        .eq('id', locationId)
        .eq('company_id', companyId)
        .eq('is_active', true)
        .maybeSingle();
    return data || null;
}

/** Trim and cap a free-text field coming from the shop floor. */
function text(v, max = 200) {
    return stripHtml(String(v === undefined || v === null ? '' : v)).trim().slice(0, max);
}

/** The staff member's name/initials — required on every write, for the audit trail. */
function actorLabel(req) {
    const label = text(req.body?.actor_label, 80);
    return label || null;
}

// ============================================================
// PHASE 4 / 5 SUB-MODULES
//
// Cycle counts, transfers and analytics are separate files mounted here, behind
// the same auth and feature gate. Each is self-contained: removing a line below
// removes that capability and nothing else.
// ============================================================
router.use('/', require('./inventory-counts'));          // /counts, /transfers
router.use('/analytics', require('./inventory-analytics'));

// ============================================================
// READ: STOCK LEVELS
// ============================================================

/**
 * GET /api/store/:slug/inventory/levels
 * On-hand for one location, newest movement first when unfiltered.
 * Query: location_id (required), search, status (low|out|ok), page, limit
 */
router.get('/levels', async (req, res) => {
    try {
        const companyId = req.company.id;
        const { location_id, search, status, page = 1, limit = 100 } = req.query;

        const location = await resolveLocation(companyId, location_id);
        if (!location) return res.status(400).json({ error: 'Select a valid location first.' });

        const pageNum = Math.max(1, parseInt(page) || 1);
        const pageSize = Math.min(500, Math.max(1, parseInt(limit) || 100));

        let query = supabaseAdmin
            .from('inventory_status')
            .select('*', { count: 'exact' })
            .eq('company_id', companyId)
            .eq('location_id', location.id);

        if (status && ['low', 'out', 'ok', 'untracked'].includes(status)) {
            query = query.eq('stock_status', status);
        }
        if (search) {
            const term = String(search).replace(/[%,()]/g, '').slice(0, 60);
            if (term) query = query.or(`product_name.ilike.%${term}%,sku.ilike.%${term}%,brand.ilike.%${term}%`);
        }

        const offset = (pageNum - 1) * pageSize;
        query = query
            .order('stock_status', { ascending: true })
            .order('product_name', { ascending: true })
            .range(offset, offset + pageSize - 1);

        const { data, error, count } = await query;
        if (error) throw error;

        res.json({
            location: { id: location.id, name: location.name },
            levels: data || [],
            total: count || 0,
            page: pageNum,
            limit: pageSize
        });
    } catch (err) {
        console.error('Inventory levels error:', err);
        res.status(500).json({ error: 'Failed to load stock levels.' });
    }
});

/**
 * GET /api/store/:slug/inventory/summary?location_id=
 * Counters for the tab header and the low-stock badge.
 */
router.get('/summary', async (req, res) => {
    try {
        const companyId = req.company.id;
        const location = await resolveLocation(companyId, req.query.location_id);
        if (!location) return res.status(400).json({ error: 'Select a valid location first.' });

        const { data, error } = await supabaseAdmin
            .from('inventory_status')
            .select('stock_status, on_hand, price')
            .eq('company_id', companyId)
            .eq('location_id', location.id);
        if (error) throw error;

        const rows = data || [];
        const summary = { tracked: 0, ok: 0, low: 0, out: 0, untracked: 0, stock_value: 0 };
        for (const r of rows) {
            summary[r.stock_status] = (summary[r.stock_status] || 0) + 1;
            if (r.stock_status !== 'untracked') summary.tracked++;
            summary.stock_value += Number(r.on_hand || 0) * Number(r.price || 0);
        }
        summary.stock_value = Math.round(summary.stock_value * 100) / 100;

        const { count: pendingCount } = await supabaseAdmin
            .from('replenishment_orders')
            .select('id', { count: 'exact', head: true })
            .eq('company_id', companyId)
            .eq('location_id', location.id)
            .in('status', ['draft', 'pending_approval']);

        res.json({ summary, pending_replenishment: pendingCount || 0 });
    } catch (err) {
        console.error('Inventory summary error:', err);
        res.status(500).json({ error: 'Failed to load inventory summary.' });
    }
});

// ============================================================
// SCAN LOOKUP
// ============================================================

/**
 * GET /api/store/:slug/inventory/lookup?code=&location_id=
 *
 * Resolve a scanned barcode (or a typed part number) to a product plus its
 * level at this location.
 *
 * The CHC master file contains 11 barcodes shared by more than one SKU, so an
 * ambiguous scan returns 300 with the candidates rather than silently picking
 * one — the shop floor decides which item they are actually holding.
 */
router.get('/lookup', async (req, res) => {
    try {
        const companyId = req.company.id;
        const location = await resolveLocation(companyId, req.query.location_id);
        if (!location) return res.status(400).json({ error: 'Select a valid location first.' });

        const raw = String(req.query.code || '').trim().slice(0, 128);
        if (!raw) return res.status(400).json({ error: 'No code supplied.' });

        const variants = barcodeVariants(raw);
        let products = [];
        let matchedBy = 'barcode';

        if (variants.length) {
            const { data, error } = await supabaseAdmin
                .from('product_barcodes')
                .select('barcode, symbology, products!inner(id, name, sku, brand, category, price, case_qty, unit, is_active, company_id)')
                .in('barcode', variants)
                .eq('products.company_id', companyId)
                .eq('products.is_active', true)
                .limit(20);
            if (error) throw error;
            products = dedupeProducts((data || []).map(r => r.products));
        }

        // Fall back to the part number, so a keyboard-wedge scan of a shelf label
        // or a typed SKU works the same way as a UPC scan.
        if (products.length === 0) {
            matchedBy = 'sku';
            const { data } = await supabaseAdmin
                .from('products')
                .select('id, name, sku, brand, category, price, case_qty, unit, is_active')
                .eq('company_id', companyId)
                .eq('is_active', true)
                .ilike('sku', raw)
                .limit(20);
            products = dedupeProducts(data || []);
        }

        if (products.length === 0) {
            return res.status(404).json({
                error: 'No product matches that code.',
                code: raw,
                canonical: canonicalBarcode(raw)
            });
        }

        const levels = await levelsFor(companyId, location.id, products.map(p => p.id));

        if (products.length > 1) {
            return res.status(300).json({
                ambiguous: true,
                message: 'More than one item shares this barcode — choose the one you are holding.',
                code: raw,
                matched_by: matchedBy,
                candidates: products.map(p => ({ ...p, level: levels[p.id] || null }))
            });
        }

        const product = products[0];
        res.json({
            code: raw,
            matched_by: matchedBy,
            product,
            level: levels[product.id] || null
        });
    } catch (err) {
        console.error('Inventory lookup error:', err);
        res.status(500).json({ error: 'Failed to look up that code.' });
    }
});

function dedupeProducts(list) {
    const seen = new Map();
    for (const p of list) {
        if (p && p.id && !seen.has(p.id)) seen.set(p.id, p);
    }
    return [...seen.values()];
}

/** Levels for a set of products at one location, keyed by product id. */
async function levelsFor(companyId, locationId, productIds) {
    if (!productIds.length) return {};
    const { data } = await supabaseAdmin
        .from('inventory_levels')
        .select('product_id, on_hand, min_point, max_point, reorder_qty, bin_location, is_tracked')
        .eq('company_id', companyId)
        .eq('location_id', locationId)
        .in('product_id', productIds);
    const map = {};
    for (const l of data || []) map[l.product_id] = l;
    return map;
}

// ============================================================
// WRITE: STOCK MOVEMENTS
// ============================================================

/**
 * POST /api/store/:slug/inventory/movements
 *
 * Body: { location_id, product_id, movement_type, quantity, reason?, job_ref?,
 *         scanned_barcode?, actor_label }
 *
 * Writes one ledger row. inventory_levels.on_hand is maintained by the database
 * trigger installed in migration 012, so on-hand and the ledger cannot diverge.
 */
router.post('/movements', async (req, res) => {
    try {
        const companyId = req.company.id;
        const settings = req.inventorySettings;

        const location = await resolveLocation(companyId, req.body?.location_id);
        if (!location) return res.status(400).json({ error: 'Select a valid location first.' });

        const actor = actorLabel(req);
        if (!actor) return res.status(400).json({ error: 'Enter your name so the movement can be attributed.' });

        const movementType = String(req.body?.movement_type || '').trim();
        if (!STORE_MOVEMENT_TYPES.includes(movementType)) {
            return res.status(400).json({ error: `Movement type must be one of: ${STORE_MOVEMENT_TYPES.join(', ')}` });
        }

        const productId = req.body?.product_id;
        if (!productId || !isValidUUID(productId)) {
            return res.status(400).json({ error: 'A valid product is required.' });
        }

        const { data: product } = await supabaseAdmin
            .from('products')
            .select('id, name, sku, price, category, is_active')
            .eq('id', productId)
            .eq('company_id', companyId)
            .maybeSingle();
        if (!product) return res.status(404).json({ error: 'Product not found for this account.' });
        if (product.is_active === false) {
            return res.status(400).json({ error: 'That product is no longer active in the catalogue.' });
        }

        // A location locked to one category (e.g. Equipment-only shops) must not
        // accumulate stock outside it — the same rule the order flow enforces.
        if (location.restrict_to_category && (product.category || '') !== location.restrict_to_category) {
            return res.status(400).json({
                error: `${location.name} only stocks ${location.restrict_to_category} items.`
            });
        }

        const existing = (await levelsFor(companyId, location.id, [product.id]))[product.id] || null;
        const currentOnHand = Number(existing?.on_hand ?? 0);

        const delta = movementDelta(movementType, req.body?.quantity, currentOnHand);
        if (!delta.ok) return res.status(400).json({ error: delta.error });

        if (!settings.allow_negative && currentOnHand + delta.delta < 0) {
            return res.status(409).json({
                error: `Only ${currentOnHand} on hand — that would take ${product.name} negative.`,
                on_hand: currentOnHand,
                requested: Math.abs(delta.delta)
            });
        }

        const { data: movement, error } = await supabaseAdmin
            .from('stock_movements')
            .insert({
                company_id: companyId,
                location_id: location.id,
                product_id: product.id,
                qty_change: delta.delta,
                movement_type: movementType,
                reason: text(req.body?.reason, 300) || MOVEMENT_TYPES[movementType].label,
                job_ref: text(req.body?.job_ref, 60) || null,
                scanned_barcode: req.body?.scanned_barcode ? canonicalBarcode(req.body.scanned_barcode) : null,
                actor_type: 'store',
                actor_label: actor,
                source_doc_type: 'store_scan'
            })
            .select('id, qty_change, movement_type, on_hand_after, created_at')
            .single();

        if (error) throw error;

        // Auto-draft replenishment when this movement crossed the minimum.
        let replenishment = null;
        if (settings.auto_draft) {
            replenishment = await maybeDraftReplenishment({
                companyId,
                location,
                product,
                actor,
                onHand: Number(movement.on_hand_after ?? currentOnHand + delta.delta),
                level: existing
            });
        }

        res.status(201).json({
            message: `${MOVEMENT_TYPES[movementType].label} recorded.`,
            movement,
            on_hand: Number(movement.on_hand_after),
            product: { id: product.id, name: product.name, sku: product.sku },
            replenishment
        });
    } catch (err) {
        console.error('Stock movement error:', err);
        res.status(500).json({ error: 'Failed to record that movement.' });
    }
});

/**
 * POST /api/store/:slug/inventory/movements/bulk
 *
 * A scan session posted in one go — the phone can queue scans offline and flush
 * them when it reconnects. Each line succeeds or fails on its own so one bad
 * scan does not discard the rest of the session.
 *
 * Body: { location_id, actor_label, movements: [{product_id, movement_type, quantity, ...}] }
 */
router.post('/movements/bulk', async (req, res) => {
    try {
        const companyId = req.company.id;
        const location = await resolveLocation(companyId, req.body?.location_id);
        if (!location) return res.status(400).json({ error: 'Select a valid location first.' });

        const actor = actorLabel(req);
        if (!actor) return res.status(400).json({ error: 'Enter your name so the movements can be attributed.' });

        const lines = Array.isArray(req.body?.movements) ? req.body.movements : [];
        if (lines.length === 0) return res.status(400).json({ error: 'No movements supplied.' });
        if (lines.length > 500) return res.status(400).json({ error: 'Maximum 500 movements per batch.' });

        const results = [];
        for (const [idx, line] of lines.entries()) {
            try {
                const outcome = await postOneMovement({
                    companyId,
                    location,
                    actor,
                    settings: req.inventorySettings,
                    line
                });
                results.push({ index: idx, ...outcome });
            } catch (e) {
                results.push({ index: idx, ok: false, error: e.message || 'Failed to record movement.' });
            }
        }

        const applied = results.filter(r => r.ok).length;
        res.status(applied ? 201 : 400).json({
            message: `${applied} of ${lines.length} movements recorded.`,
            applied,
            failed: results.length - applied,
            results
        });
    } catch (err) {
        console.error('Bulk movement error:', err);
        res.status(500).json({ error: 'Failed to record that batch.' });
    }
});

/** Shared single-movement path used by the bulk endpoint. */
async function postOneMovement({ companyId, location, actor, settings, line }) {
    const movementType = String(line?.movement_type || '').trim();
    if (!STORE_MOVEMENT_TYPES.includes(movementType)) {
        return { ok: false, error: `Unsupported movement type "${movementType}"` };
    }
    if (!line?.product_id || !isValidUUID(line.product_id)) {
        return { ok: false, error: 'Invalid product' };
    }

    const { data: product } = await supabaseAdmin
        .from('products')
        .select('id, name, sku, category, is_active')
        .eq('id', line.product_id)
        .eq('company_id', companyId)
        .maybeSingle();
    if (!product) return { ok: false, error: 'Product not found' };
    if (product.is_active === false) return { ok: false, error: `${product.sku || product.name} is not active` };
    if (location.restrict_to_category && (product.category || '') !== location.restrict_to_category) {
        return { ok: false, error: `${location.name} only stocks ${location.restrict_to_category} items` };
    }

    const existing = (await levelsFor(companyId, location.id, [product.id]))[product.id] || null;
    const currentOnHand = Number(existing?.on_hand ?? 0);

    const delta = movementDelta(movementType, line.quantity, currentOnHand);
    if (!delta.ok) return { ok: false, error: delta.error, product_id: product.id };

    if (!settings.allow_negative && currentOnHand + delta.delta < 0) {
        return { ok: false, error: `Only ${currentOnHand} on hand for ${product.sku || product.name}`, product_id: product.id };
    }

    const { data: movement, error } = await supabaseAdmin
        .from('stock_movements')
        .insert({
            company_id: companyId,
            location_id: location.id,
            product_id: product.id,
            qty_change: delta.delta,
            movement_type: movementType,
            reason: text(line.reason, 300) || MOVEMENT_TYPES[movementType].label,
            job_ref: text(line.job_ref, 60) || null,
            scanned_barcode: line.scanned_barcode ? canonicalBarcode(line.scanned_barcode) : null,
            actor_type: 'store',
            actor_label: actor,
            source_doc_type: 'store_scan_batch'
        })
        .select('id, on_hand_after')
        .single();
    if (error) return { ok: false, error: error.message, product_id: product.id };

    if (settings.auto_draft) {
        await maybeDraftReplenishment({
            companyId, location, product, actor,
            onHand: Number(movement.on_hand_after ?? currentOnHand + delta.delta),
            level: existing
        });
    }

    return {
        ok: true,
        movement_id: movement.id,
        product_id: product.id,
        sku: product.sku,
        on_hand: Number(movement.on_hand_after)
    };
}

/**
 * GET /api/store/:slug/inventory/movements?location_id=&product_id=&limit=
 * The ledger, newest first — the audit trail as the shop floor sees it.
 */
router.get('/movements', async (req, res) => {
    try {
        const companyId = req.company.id;
        const location = await resolveLocation(companyId, req.query.location_id);
        if (!location) return res.status(400).json({ error: 'Select a valid location first.' });

        const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));

        let query = supabaseAdmin
            .from('stock_movements')
            .select('id, product_id, qty_change, movement_type, reason, job_ref, scanned_barcode, actor_label, on_hand_after, created_at, products(name, sku, brand)')
            .eq('company_id', companyId)
            .eq('location_id', location.id)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (req.query.product_id && isValidUUID(req.query.product_id)) {
            query = query.eq('product_id', req.query.product_id);
        }
        if (req.query.movement_type && STORE_MOVEMENT_TYPES.includes(req.query.movement_type)) {
            query = query.eq('movement_type', req.query.movement_type);
        }
        if (req.query.from) query = query.gte('created_at', new Date(req.query.from).toISOString());
        if (req.query.to) query = query.lte('created_at', new Date(req.query.to).toISOString());

        const { data, error } = await query;
        if (error) throw error;

        res.json({ movements: data || [] });
    } catch (err) {
        console.error('Movement history error:', err);
        res.status(500).json({ error: 'Failed to load movement history.' });
    }
});

// ============================================================
// REORDER POINTS
// ============================================================

/**
 * PUT /api/store/:slug/inventory/levels/:productId
 * Set min / reorder / max / bin for one product at one location.
 * Body: { location_id, min_point, max_point, reorder_qty, bin_location, is_tracked }
 */
router.put('/levels/:productId', async (req, res) => {
    try {
        const companyId = req.company.id;
        const location = await resolveLocation(companyId, req.body?.location_id);
        if (!location) return res.status(400).json({ error: 'Select a valid location first.' });

        const productId = req.params.productId;
        if (!isValidUUID(productId)) return res.status(400).json({ error: 'Invalid product.' });

        const { data: product } = await supabaseAdmin
            .from('products').select('id').eq('id', productId).eq('company_id', companyId).maybeSingle();
        if (!product) return res.status(404).json({ error: 'Product not found for this account.' });

        const num = (v) => {
            if (v === null || v === '' || v === undefined) return null;
            const n = Number(v);
            if (!Number.isFinite(n) || n < 0 || n > 1000000) throw new Error('Reorder points must be between 0 and 1,000,000.');
            return n;
        };

        let minPoint, maxPoint, reorderQty;
        try {
            minPoint = num(req.body.min_point);
            maxPoint = num(req.body.max_point);
            reorderQty = num(req.body.reorder_qty);
        } catch (e) {
            return res.status(400).json({ error: e.message });
        }

        if (minPoint !== null && maxPoint !== null && maxPoint < minPoint) {
            return res.status(400).json({ error: 'Max must be at or above min.' });
        }

        const patch = {
            company_id: companyId,
            location_id: location.id,
            product_id: productId,
            min_point: minPoint,
            max_point: maxPoint,
            reorder_qty: reorderQty,
            bin_location: text(req.body.bin_location, 40) || null,
            updated_at: new Date().toISOString()
        };
        if (req.body.is_tracked !== undefined) patch.is_tracked = !!req.body.is_tracked;

        // on_hand is deliberately absent: it is only ever moved by the ledger.
        const { data, error } = await supabaseAdmin
            .from('inventory_levels')
            .upsert(patch, { onConflict: 'location_id,product_id' })
            .select()
            .single();
        if (error) throw error;

        res.json({ level: data });
    } catch (err) {
        console.error('Set reorder points error:', err);
        res.status(500).json({ error: 'Failed to save reorder points.' });
    }
});

// ============================================================
// REPLENISHMENT QUEUE
// ============================================================

/**
 * Add or top up a replenishment line when a level has fallen to its minimum.
 * Lines accumulate into a single open order per location (enforced by the
 * partial unique index in migration 012), so a busy morning of scanning
 * produces one queue to approve rather than dozens of orders.
 */
async function maybeDraftReplenishment({ companyId, location, product, actor, onHand, level }) {
    try {
        const effective = { ...(level || {}), on_hand: onHand };
        const decision = replenishmentFor(effective);
        if (!decision.trigger) return null;

        let { data: open } = await supabaseAdmin
            .from('replenishment_orders')
            .select('id, status')
            .eq('company_id', companyId)
            .eq('location_id', location.id)
            .in('status', ['draft', 'pending_approval'])
            .maybeSingle();

        if (!open) {
            const { data: created, error: createErr } = await supabaseAdmin
                .from('replenishment_orders')
                .insert({
                    company_id: companyId,
                    location_id: location.id,
                    status: 'pending_approval',
                    created_by_label: actor,
                    submitted_at: new Date().toISOString(),
                    notes: 'refinishAI Inventory — auto-drafted from shelf minimums'
                })
                .select('id, status')
                .single();
            // A concurrent scan may have created it first; fall back to reading it.
            if (createErr) {
                const { data: raced } = await supabaseAdmin
                    .from('replenishment_orders')
                    .select('id, status')
                    .eq('company_id', companyId)
                    .eq('location_id', location.id)
                    .in('status', ['draft', 'pending_approval'])
                    .maybeSingle();
                if (!raced) throw createErr;
                open = raced;
            } else {
                open = created;
            }
        }

        const { data: line, error: lineErr } = await supabaseAdmin
            .from('replenishment_order_lines')
            .upsert({
                order_id: open.id,
                product_id: product.id,
                sku: product.sku,
                name: product.name,
                quantity: decision.qty,
                unit_price: product.price ?? null,
                on_hand_at_draft: onHand,
                min_point: effective.min_point ?? null,
                max_point: effective.max_point ?? null,
                source: 'auto_min_point'
            }, { onConflict: 'order_id,product_id' })
            .select('id, quantity')
            .single();
        if (lineErr) throw lineErr;

        await supabaseAdmin
            .from('replenishment_orders')
            .update({ updated_at: new Date().toISOString() })
            .eq('id', open.id);

        return {
            order_id: open.id,
            line_id: line.id,
            quantity: Number(line.quantity),
            reason: decision.reason
        };
    } catch (err) {
        // Never fail the movement because the draft failed — the stock change is
        // the source of truth and the queue can be rebuilt from levels.
        console.error('Replenishment draft failed (non-blocking):', err.message);
        return null;
    }
}

/**
 * GET /api/store/:slug/inventory/replenishment?location_id=&status=
 */
router.get('/replenishment', async (req, res) => {
    try {
        const companyId = req.company.id;
        const location = await resolveLocation(companyId, req.query.location_id);
        if (!location) return res.status(400).json({ error: 'Select a valid location first.' });

        const statuses = req.query.status
            ? [String(req.query.status)]
            : ['draft', 'pending_approval'];

        const { data, error } = await supabaseAdmin
            .from('replenishment_orders')
            .select('id, status, notes, created_by_label, approved_by_label, decision_reason, order_id, created_at, submitted_at, approved_at, rejected_at, replenishment_order_lines(id, product_id, sku, name, quantity, unit_price, on_hand_at_draft, min_point, max_point, source)')
            .eq('company_id', companyId)
            .eq('location_id', location.id)
            .in('status', statuses)
            .order('created_at', { ascending: false })
            .limit(50);
        if (error) throw error;

        const orders = (data || []).map(o => {
            const lines = o.replenishment_order_lines || [];
            const total = lines.reduce((s, l) => s + Number(l.quantity || 0) * Number(l.unit_price || 0), 0);
            return { ...o, line_count: lines.length, estimated_total: Math.round(total * 100) / 100 };
        });

        res.json({ orders });
    } catch (err) {
        console.error('Replenishment list error:', err);
        res.status(500).json({ error: 'Failed to load the replenishment queue.' });
    }
});

/**
 * PUT /api/store/:slug/inventory/replenishment/:id/lines/:lineId
 * A manager tuning a line before approving. Quantity 0 removes the line.
 */
router.put('/replenishment/:id/lines/:lineId', async (req, res) => {
    try {
        const companyId = req.company.id;
        const order = await loadOpenReplenishment(companyId, req.params.id);
        if (!order) return res.status(404).json({ error: 'Replenishment order not found or already decided.' });

        const qty = Number(req.body?.quantity);
        if (!Number.isFinite(qty) || qty < 0 || qty > 100000) {
            return res.status(400).json({ error: 'Quantity must be between 0 and 100,000.' });
        }

        if (qty === 0) {
            const { error } = await supabaseAdmin
                .from('replenishment_order_lines')
                .delete().eq('id', req.params.lineId).eq('order_id', order.id);
            if (error) throw error;
            return res.json({ message: 'Line removed.' });
        }

        const { data, error } = await supabaseAdmin
            .from('replenishment_order_lines')
            .update({ quantity: Math.ceil(qty), source: 'manual' })
            .eq('id', req.params.lineId)
            .eq('order_id', order.id)
            .select()
            .single();
        if (error) throw error;

        res.json({ line: data });
    } catch (err) {
        console.error('Replenishment line update error:', err);
        res.status(500).json({ error: 'Failed to update that line.' });
    }
});

async function loadOpenReplenishment(companyId, id) {
    if (!isValidUUID(id)) return null;
    const { data } = await supabaseAdmin
        .from('replenishment_orders')
        .select('id, company_id, location_id, status')
        .eq('id', id)
        .eq('company_id', companyId)
        .in('status', ['draft', 'pending_approval'])
        .maybeSingle();
    return data || null;
}

/**
 * POST /api/store/:slug/inventory/replenishment/:id/approve
 *
 * The gate the design calls for: a manager reviews the auto-drafted queue and
 * approves it, at which point it becomes a real CHC order through exactly the
 * same path as a manually placed one — server-side pricing, promotions, branch
 * routing and the standard notification email.
 *
 * Body: { po_number, contact_name, contact_email, actor_label, notes? }
 */
router.post('/replenishment/:id/approve', async (req, res) => {
    try {
        const companyId = req.company.id;

        const order = await loadOpenReplenishment(companyId, req.params.id);
        if (!order) return res.status(404).json({ error: 'Replenishment order not found or already decided.' });

        const actor = actorLabel(req);
        if (!actor) return res.status(400).json({ error: 'Enter your name to approve this order.' });

        const poNumber = text(req.body?.po_number, 60);
        const contactName = text(req.body?.contact_name, 100);
        const contactEmail = text(req.body?.contact_email, 160).toLowerCase();

        if (!poNumber) return res.status(400).json({ error: 'PO Number is required.' });
        if (!contactName) return res.status(400).json({ error: 'Contact name is required.' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
            return res.status(400).json({ error: 'A valid contact email is required.' });
        }

        const location = await resolveLocation(companyId, order.location_id);
        if (!location) return res.status(400).json({ error: 'This location is no longer active.' });

        const { data: lines } = await supabaseAdmin
            .from('replenishment_order_lines')
            .select('id, product_id, quantity')
            .eq('order_id', order.id);

        if (!lines || lines.length === 0) {
            return res.status(400).json({ error: 'There is nothing to order — the queue is empty.' });
        }

        const productIds = lines.map(l => l.product_id);
        const { data: products } = await supabaseAdmin
            .from('products')
            .select('id, name, sku, price, category, is_active')
            .eq('company_id', companyId)
            .in('id', productIds);

        const productMap = {};
        for (const p of products || []) productMap[p.id] = p;

        const missing = lines.filter(l => !productMap[l.product_id] || productMap[l.product_id].is_active === false);
        if (missing.length) {
            return res.status(400).json({
                error: 'Some items are no longer available. Remove them from the queue and approve again.',
                unavailable_line_ids: missing.map(l => l.id)
            });
        }

        if (location.restrict_to_category) {
            const off = lines.find(l => (productMap[l.product_id].category || '') !== location.restrict_to_category);
            if (off) {
                return res.status(400).json({
                    error: `${location.name} can only order ${location.restrict_to_category} items. Remove the others from the queue.`
                });
            }
        }

        // Same promotion precedence as routes/storefront.js: global first, then
        // company-specific, so an approved replenishment is never priced worse
        // than the same basket placed by hand.
        const now = new Date().toISOString();
        const promoMap = {};
        const { data: globalPromos } = await supabaseAdmin
            .from('promotions').select('product_id, promo_price')
            .is('company_id', null).eq('is_active', true)
            .lte('starts_at', now).gte('ends_at', now).in('product_id', productIds);
        const { data: companyPromos } = await supabaseAdmin
            .from('promotions').select('product_id, promo_price')
            .eq('company_id', companyId).eq('is_active', true)
            .lte('starts_at', now).gte('ends_at', now).in('product_id', productIds);
        for (const p of globalPromos || []) promoMap[p.product_id] = p.promo_price;
        for (const p of companyPromos || []) promoMap[p.product_id] = p.promo_price;

        let subtotal = 0;
        const items = lines.map(l => {
            const product = productMap[l.product_id];
            const qty = Math.max(1, Math.ceil(Number(l.quantity) || 1));
            const unitPrice = Number(promoMap[l.product_id] ?? product.price ?? 0);
            const lineTotal = unitPrice * qty;
            subtotal += lineTotal;
            return {
                product_id: product.id,
                name: product.name,
                sku: product.sku,
                quantity: qty,
                unit_price: unitPrice,
                was_promo: promoMap[l.product_id] !== undefined,
                subtotal: lineTotal
            };
        });
        subtotal = Math.round(subtotal * 100) / 100;

        const notes = text(req.body?.notes, 500);
        const orderNotes = [`refinishAI Inventory replenishment, approved by ${actor}`, notes].filter(Boolean).join(' — ');

        const { data: createdOrder, error: orderErr } = await supabaseAdmin
            .from('orders')
            .insert({
                company_id: companyId,
                contact_name: contactName,
                contact_email: contactEmail,
                contact_phone: text(req.body?.contact_phone, 40),
                company_name: req.company.name,
                po_number: poNumber,
                location: location.name,
                location_id: location.id,
                items,
                subtotal,
                total: subtotal,
                notes: orderNotes,
                status: 'pending',
                status_history: [{
                    status: 'pending',
                    timestamp: now,
                    note: `refinishAI Inventory replenishment approved by ${actor}`
                }]
            })
            .select()
            .single();

        if (orderErr) {
            console.error('Replenishment order insert error:', orderErr);
            return res.status(500).json({ error: 'Failed to raise the order.' });
        }

        const { error: closeErr } = await supabaseAdmin
            .from('replenishment_orders')
            .update({
                status: 'approved',
                approved_at: now,
                approved_by_label: actor,
                order_id: createdOrder.id,
                po_number: poNumber,
                contact_name: contactName,
                contact_email: contactEmail,
                decision_reason: notes || null,
                updated_at: now
            })
            .eq('id', order.id)
            .in('status', ['draft', 'pending_approval']);

        if (closeErr) console.error('Replenishment close error (order was raised):', closeErr.message);

        // Notification reuses the standard order routing so the servicing CHC
        // branch is emailed exactly as it is for a hand-placed order.
        try {
            const { to, replyTo } = await resolveOrderRecipients({
                company_id: companyId,
                location_id: location.id,
                contact_email: contactEmail
            });
            if (to.length) {
                sendOrderNotification({
                    to,
                    replyTo,
                    order: { ...createdOrder, items },
                    companyName: req.company.name,
                    contactName,
                    contactEmail,
                    contactPhone: text(req.body?.contact_phone, 40),
                    poNumber,
                    location: location.name,
                    notes: orderNotes
                }).catch(e => console.error('Replenishment email failed (non-blocking):', e.message));
            }
        } catch (e) {
            console.error('Replenishment recipients error (non-blocking):', e.message);
        }

        res.status(201).json({
            message: 'Replenishment approved and sent to CHC.',
            order: {
                id: createdOrder.id,
                order_number: createdOrder.order_number,
                total: createdOrder.total,
                status: createdOrder.status,
                created_at: createdOrder.created_at
            },
            line_count: items.length
        });
    } catch (err) {
        console.error('Replenishment approve error:', err);
        res.status(500).json({ error: 'Failed to approve that replenishment.' });
    }
});

/**
 * POST /api/store/:slug/inventory/replenishment/:id/reject
 * Body: { reason (required), actor_label }
 *
 * A reason is required, matching how the console handles other reversible
 * decisions: the queue closes but the record of why survives.
 */
router.post('/replenishment/:id/reject', async (req, res) => {
    try {
        const companyId = req.company.id;
        const order = await loadOpenReplenishment(companyId, req.params.id);
        if (!order) return res.status(404).json({ error: 'Replenishment order not found or already decided.' });

        const actor = actorLabel(req);
        if (!actor) return res.status(400).json({ error: 'Enter your name to reject this order.' });

        const reason = text(req.body?.reason, 300);
        if (!reason) return res.status(400).json({ error: 'A reason is required when rejecting a replenishment.' });

        const now = new Date().toISOString();
        const { data, error } = await supabaseAdmin
            .from('replenishment_orders')
            .update({
                status: 'rejected',
                rejected_at: now,
                approved_by_label: actor,
                decision_reason: reason,
                updated_at: now
            })
            .eq('id', order.id)
            .in('status', ['draft', 'pending_approval'])
            .select('id, status, rejected_at')
            .single();
        if (error) throw error;

        res.json({ message: 'Replenishment rejected.', order: data });
    } catch (err) {
        console.error('Replenishment reject error:', err);
        res.status(500).json({ error: 'Failed to reject that replenishment.' });
    }
});

/**
 * POST /api/store/:slug/inventory/replenishment/refresh
 * Rebuild the queue from current levels — useful after editing reorder points,
 * or as a nightly sweep. Body: { location_id, actor_label }
 */
router.post('/replenishment/refresh', async (req, res) => {
    try {
        const companyId = req.company.id;
        const location = await resolveLocation(companyId, req.body?.location_id);
        if (!location) return res.status(400).json({ error: 'Select a valid location first.' });

        const actor = actorLabel(req) || 'System';

        const { data: lowLevels, error } = await supabaseAdmin
            .from('inventory_status')
            .select('product_id, sku, product_name, price, on_hand, min_point, max_point, reorder_qty, is_tracked')
            .eq('company_id', companyId)
            .eq('location_id', location.id)
            .in('stock_status', ['low', 'out'])
            .limit(1000);
        if (error) throw error;

        let added = 0;
        for (const level of lowLevels || []) {
            const result = await maybeDraftReplenishment({
                companyId,
                location,
                product: { id: level.product_id, sku: level.sku, name: level.product_name, price: level.price },
                actor,
                onHand: Number(level.on_hand),
                level
            });
            if (result) added++;
        }

        res.json({ message: `${added} item${added === 1 ? '' : 's'} queued for replenishment.`, queued: added });
    } catch (err) {
        console.error('Replenishment refresh error:', err);
        res.status(500).json({ error: 'Failed to refresh the replenishment queue.' });
    }
});

module.exports = router;
