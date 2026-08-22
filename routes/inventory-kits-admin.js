/**
 * routes/inventory-kits-admin.js
 *
 * refinishAI Inventory — kit administration, mounted from routes/inventory-admin.js at
 *   /api/admin/companies/:companyId/inventory/kits
 *
 * The parent applies requireAdminAuth and requireCompanyAccess before this file
 * is reached; both are re-applied at the mount so the file cannot be remounted
 * somewhere less protected.
 *
 * Two jobs live here.
 *
 * A. TURNING KITS ON. Which CHC master kits a company may use, and any kits the
 *    company has of its own.
 *
 * B. MAPPING. A master kit line is a SKU string from wherever the kit came from
 *    — the 15 kits in this database arrived from a Skyline export and 13 of
 *    their 17 SKUs are not CHC part numbers at all. Somebody who knows the
 *    catalogue has to say what each line means, once, per company. This file is
 *    where that happens, with candidate suggestions to make it quick and an
 *    explicit refusal to auto-apply them.
 *
 * On suggestions: they are ranked and returned, never written. Matching a paint
 * or adhesive SKU to the wrong product would expense the wrong material off the
 * shelf and mis-cost every job that used the kit — quietly, and for as long as
 * nobody checked. A wrong mapping is worse than no mapping, so the last step is
 * always a person.
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requireCompanyAccess } = require('../middleware/auth');
const { stripHtml, isValidUUID } = require('../utils/sanitize');

const router = express.Router({ mergeParams: true });

router.use(requireCompanyAccess);

function text(v, max = 200) {
    return stripHtml(String(v === undefined || v === null ? '' : v)).trim().slice(0, max);
}

async function logAction(adminId, action, entityType, entityId, details, ip) {
    try {
        await supabaseAdmin.from('audit_log').insert({
            admin_id: adminId, action, entity_type: entityType,
            entity_id: entityId, details, ip_address: ip
        });
    } catch (err) {
        console.error('Audit log write failed:', err);
    }
}

/** Normalise a part number for comparison: case and punctuation carry no meaning. */
function normalizeSku(sku) {
    return String(sku || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Vendor prefixes used across the CHC catalogue. Knowing that MMM is 3M lets a
 * suggestion say "same vendor, different product" instead of ranking blindly.
 */
const VENDOR_PREFIXES = {
    MMM: '3M', FUS: 'Fusor', PRF: 'ProForm', NOR: 'Norton',
    UP: 'U-POL', SU: 'OneChoice', SX: 'OneChoice', ACM: 'Acme',
    AQB: 'Aqua Base', GLO: 'Glasurit'
};

function vendorOf(sku) {
    const s = normalizeSku(sku);
    for (const prefix of Object.keys(VENDOR_PREFIXES).sort((a, b) => b.length - a.length)) {
        if (s.startsWith(prefix)) return { prefix, vendor: VENDOR_PREFIXES[prefix], rest: s.slice(prefix.length) };
    }
    return { prefix: null, vendor: null, rest: s };
}

/**
 * Rank catalogue products as candidates for one kit SKU.
 *
 * Deliberately conservative and deliberately transparent: every candidate
 * carries the reason it was suggested, so the person choosing can see whether
 * the match is an exact part number or a guess from a shared vendor prefix.
 */
function suggestProducts(kitSku, products) {
    const target = normalizeSku(kitSku);
    if (!target) return [];

    const { prefix, vendor, rest } = vendorOf(kitSku);
    const scored = [];

    for (const p of products) {
        const candidate = normalizeSku(p.sku);
        if (!candidate) continue;

        let score = 0;
        let why = null;

        if (candidate === target) {
            score = 100; why = 'Exact part number';
        } else if (candidate.endsWith(target) || target.endsWith(candidate)) {
            score = 80; why = 'Part number matches apart from a prefix';
        } else if (candidate.includes(target) || target.includes(candidate)) {
            score = 70; why = 'Part number contains the other';
        } else if (prefix && candidate.startsWith(prefix) && rest.length >= 4 && candidate.includes(rest)) {
            score = 60; why = `Same vendor (${vendor}) and matching digits`;
        } else if (prefix && candidate.startsWith(prefix) && rest.length >= 3) {
            // The vendor's digits are usually the product. Reward a near miss
            // only when most of them line up.
            const candRest = candidate.slice(prefix.length);
            const shared = commonPrefixLength(candRest, rest);
            if (shared >= 3) {
                score = 30 + shared * 4;
                why = `Same vendor (${vendor}), first ${shared} digits match`;
            }
        }

        if (score > 0) scored.push({ ...p, score, why });
    }

    return scored
        .sort((a, b) => b.score - a.score || String(a.sku).localeCompare(String(b.sku)))
        .slice(0, 8)
        .map(c => ({
            product_id: c.id, sku: c.sku, name: c.name,
            price: Number(c.price ?? 0), category: c.category || null,
            confidence: c.score >= 100 ? 'exact' : c.score >= 70 ? 'likely' : 'possible',
            why: c.why
        }));
}

function commonPrefixLength(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
    return i;
}

// ============================================================
// KIT LISTING AND ACCESS
// ============================================================

/**
 * GET /kits
 * Every kit CHC could offer this company, with whether it is switched on and how
 * far through mapping it is. `ready` is the only number that matters
 * operationally: a kit that is on but unmapped will refuse at the counter.
 */
router.get('/', async (req, res) => {
    try {
        const companyId = req.params.companyId;

        const [{ data: master }, { data: own }, { data: access }] = await Promise.all([
            supabaseAdmin.from('repair_kits')
                .select('id, name, description, source, sort_order, is_active, company_id')
                .is('company_id', null),
            supabaseAdmin.from('repair_kits')
                .select('id, name, description, source, sort_order, is_active, company_id')
                .eq('company_id', companyId),
            supabaseAdmin.from('company_kit_access')
                .select('kit_id, enabled')
                .eq('company_id', companyId)
        ]);

        const kits = [...(master || []), ...(own || [])];
        if (kits.length === 0) return res.json({ kits: [] });

        const enabledBy = new Map((access || []).map(a => [a.kit_id, a.enabled]));

        const { data: items } = await supabaseAdmin
            .from('kit_items')
            .select('id, kit_id, sku, product_id, quantity, needs_review')
            .in('kit_id', kits.map(k => k.id));

        const { data: maps } = await supabaseAdmin
            .from('kit_product_map')
            .select('kit_item_id, product_id, is_excluded')
            .eq('company_id', companyId);

        const mapByItem = new Map((maps || []).map(m => [m.kit_item_id, m]));
        const byKit = new Map();
        for (const item of items || []) {
            if (!byKit.has(item.kit_id)) byKit.set(item.kit_id, []);
            byKit.get(item.kit_id).push(item);
        }

        const out = kits.map(kit => {
            const lines = byKit.get(kit.id) || [];
            let mapped = 0, excluded = 0, unmapped = 0;

            for (const line of lines) {
                const map = mapByItem.get(line.id);
                if (map?.is_excluded) excluded += 1;
                else if (map?.product_id || line.product_id) mapped += 1;
                else unmapped += 1;
            }

            return {
                id: kit.id,
                name: kit.name,
                description: kit.description || null,
                source: kit.source || null,
                is_master: kit.company_id === null,
                is_active: kit.is_active,
                enabled: kit.company_id === companyId ? true : (enabledBy.get(kit.id) === true),
                line_count: lines.length,
                mapped, excluded, unmapped,
                needs_review: lines.filter(l => l.needs_review).length,
                ready: unmapped === 0 && mapped > 0
            };
        }).sort((a, b) => (a.is_master === b.is_master ? 0 : a.is_master ? 1 : -1) || String(a.name).localeCompare(String(b.name)));

        res.json({ kits: out });
    } catch (err) {
        console.error('Admin kit list error:', err);
        res.status(500).json({ error: 'Failed to load kits.' });
    }
});

/**
 * PUT /kits/:kitId/access   Body: { enabled }
 * Switch a CHC master kit on or off for this company. Off keeps the mapping, so
 * turning it back on does not repeat the work.
 */
router.put('/:kitId/access', async (req, res) => {
    try {
        const companyId = req.params.companyId;
        const kitId = req.params.kitId;
        if (!isValidUUID(kitId)) return res.status(400).json({ error: 'Invalid kit id.' });

        const { data: kit } = await supabaseAdmin
            .from('repair_kits').select('id, name, company_id').eq('id', kitId).maybeSingle();
        if (!kit) return res.status(404).json({ error: 'Kit not found.' });
        if (kit.company_id !== null) {
            return res.status(400).json({ error: 'That kit belongs to a company already — access cannot be granted.' });
        }

        const enabled = req.body?.enabled === true;

        const { error } = await supabaseAdmin
            .from('company_kit_access')
            .upsert({ company_id: companyId, kit_id: kitId, enabled }, { onConflict: 'company_id,kit_id' });
        if (error) throw error;

        await logAction(req.admin.id, enabled ? 'kit_enabled' : 'kit_disabled', 'company', companyId,
            { kit_id: kitId, kit: kit.name }, req.ip);

        res.json({ message: `${kit.name} ${enabled ? 'enabled' : 'disabled'}.`, enabled });
    } catch (err) {
        console.error('Kit access error:', err);
        res.status(500).json({ error: 'Failed to change kit access.' });
    }
});

// ============================================================
// MAPPING
// ============================================================

/**
 * GET /kits/:kitId/mapping
 * Every line of a kit, what it currently resolves to for this company, and
 * ranked candidates for the ones that resolve to nothing.
 */
router.get('/:kitId/mapping', async (req, res) => {
    try {
        const companyId = req.params.companyId;
        const kitId = req.params.kitId;
        if (!isValidUUID(kitId)) return res.status(400).json({ error: 'Invalid kit id.' });

        const { data: kit } = await supabaseAdmin
            .from('repair_kits').select('id, name, description, source, company_id').eq('id', kitId).maybeSingle();
        if (!kit) return res.status(404).json({ error: 'Kit not found.' });
        if (kit.company_id !== null && kit.company_id !== companyId) {
            return res.status(404).json({ error: 'Kit not found.' });
        }

        const { data: items } = await supabaseAdmin
            .from('kit_items')
            .select('id, sku, product_id, quantity, unit, sort_order, needs_review')
            .eq('kit_id', kitId)
            .order('sort_order', { ascending: true });

        const kitItems = items || [];
        if (kitItems.length === 0) return res.json({ kit, lines: [] });

        const [{ data: maps }, { data: products }] = await Promise.all([
            supabaseAdmin.from('kit_product_map')
                .select('kit_item_id, product_id, quantity, is_excluded, note, updated_at')
                .eq('company_id', companyId)
                .in('kit_item_id', kitItems.map(i => i.id)),
            supabaseAdmin.from('products')
                .select('id, sku, name, price, category, is_active')
                .eq('company_id', companyId)
                .eq('is_active', true)
        ]);

        const catalogue = products || [];
        const mapByItem = new Map((maps || []).map(m => [m.kit_item_id, m]));
        const byId = new Map(catalogue.map(p => [p.id, p]));

        const lines = kitItems.map(item => {
            const map = mapByItem.get(item.id) || null;
            const resolvedId = map ? map.product_id : item.product_id;
            const product = resolvedId ? byId.get(resolvedId) : null;

            return {
                kit_item_id: item.id,
                kit_sku: item.sku,
                kit_quantity: Number(item.quantity),
                unit: item.unit || 'each',
                needs_review: item.needs_review === true,

                is_excluded: map?.is_excluded === true,
                mapped_product: product
                    ? { id: product.id, sku: product.sku, name: product.name, price: Number(product.price ?? 0), category: product.category }
                    : null,
                quantity_override: map?.quantity !== undefined && map?.quantity !== null ? Number(map.quantity) : null,
                effective_quantity: Number(map?.quantity ?? item.quantity),
                note: map?.note || null,
                mapped_at: map?.updated_at || null,

                // Only compute suggestions where they are needed. On a resolved
                // line they would be noise.
                suggestions: (product || map?.is_excluded) ? [] : suggestProducts(item.sku, catalogue)
            };
        });

        const unmapped = lines.filter(l => !l.mapped_product && !l.is_excluded).length;

        res.json({
            kit: { id: kit.id, name: kit.name, description: kit.description, source: kit.source, is_master: kit.company_id === null },
            lines,
            unmapped,
            ready: unmapped === 0 && lines.some(l => l.mapped_product)
        });
    } catch (err) {
        console.error('Kit mapping error:', err);
        res.status(500).json({ error: 'Failed to load the kit mapping.' });
    }
});

/**
 * PUT /kits/mapping/:kitItemId
 * Body: { product_id | null, quantity | null, is_excluded, note }
 *
 * Records what one kit line means for this company. Sending product_id null
 * with is_excluded false clears the mapping and returns the line to unresolved,
 * which is how a bad mapping is undone.
 */
router.put('/mapping/:kitItemId', async (req, res) => {
    try {
        const companyId = req.params.companyId;
        const kitItemId = req.params.kitItemId;
        if (!isValidUUID(kitItemId)) return res.status(400).json({ error: 'Invalid kit line id.' });

        const { data: item } = await supabaseAdmin
            .from('kit_items')
            .select('id, sku, kit_id, repair_kits!inner(id, name, company_id)')
            .eq('id', kitItemId)
            .maybeSingle();
        if (!item) return res.status(404).json({ error: 'Kit line not found.' });

        const owner = item.repair_kits?.company_id;
        if (owner !== null && owner !== companyId) {
            return res.status(404).json({ error: 'Kit line not found.' });
        }

        const isExcluded = req.body?.is_excluded === true;
        let productId = null;

        if (!isExcluded && req.body?.product_id) {
            productId = req.body.product_id;
            if (!isValidUUID(productId)) return res.status(400).json({ error: 'Invalid product id.' });

            // The product must belong to THIS company. Without this check an
            // admin with access to one company could point a shared master kit
            // line at another company's product.
            const { data: product } = await supabaseAdmin
                .from('products')
                .select('id, sku, name, is_active')
                .eq('id', productId)
                .eq('company_id', companyId)
                .maybeSingle();
            if (!product) return res.status(400).json({ error: 'That product is not in this company\'s catalogue.' });
            if (product.is_active === false) return res.status(400).json({ error: 'That product is not active.' });
        }

        let quantity = null;
        if (req.body?.quantity !== undefined && req.body?.quantity !== null && req.body?.quantity !== '') {
            quantity = Number(req.body.quantity);
            if (!Number.isFinite(quantity) || quantity <= 0) {
                return res.status(400).json({ error: 'Quantity must be a positive number.' });
            }
            if (quantity > 100000) return res.status(400).json({ error: 'Quantity is out of range.' });
        }

        const { data: saved, error } = await supabaseAdmin
            .from('kit_product_map')
            .upsert({
                company_id: companyId,
                kit_item_id: kitItemId,
                product_id: isExcluded ? null : productId,
                quantity,
                is_excluded: isExcluded,
                note: text(req.body?.note, 300) || null,
                updated_at: new Date().toISOString(),
                updated_by: req.admin.id
            }, { onConflict: 'company_id,kit_item_id' })
            .select('id, product_id, quantity, is_excluded, note')
            .single();

        if (error) throw error;

        await logAction(req.admin.id, 'kit_line_mapped', 'company', companyId, {
            kit: item.repair_kits?.name, kit_sku: item.sku,
            product_id: saved.product_id, excluded: saved.is_excluded
        }, req.ip);

        res.json({ message: 'Mapping saved.', mapping: saved });
    } catch (err) {
        console.error('Kit mapping save error:', err);
        res.status(500).json({ error: 'Failed to save that mapping.' });
    }
});

/**
 * POST /kits/mapping/bulk
 * Body: { mappings: [{ kit_item_id, product_id, quantity, is_excluded, note }] }
 *
 * Confirming a screenful of suggestions in one go. Each line is validated on its
 * own and reported on its own — one bad row does not discard the rest of the
 * work, which matters when someone has just mapped forty lines.
 */
router.post('/mapping/bulk', async (req, res) => {
    try {
        const companyId = req.params.companyId;
        const rows = Array.isArray(req.body?.mappings) ? req.body.mappings : [];
        if (rows.length === 0) return res.status(400).json({ error: 'No mappings supplied.' });
        if (rows.length > 500) return res.status(400).json({ error: 'Maximum 500 mappings per request.' });

        // Load once rather than per row.
        const itemIds = rows.map(r => r?.kit_item_id).filter(isValidUUID);
        const productIds = rows.map(r => r?.product_id).filter(isValidUUID);

        const [{ data: items }, { data: products }] = await Promise.all([
            itemIds.length
                ? supabaseAdmin.from('kit_items')
                    .select('id, sku, repair_kits!inner(company_id)')
                    .in('id', itemIds)
                : Promise.resolve({ data: [] }),
            productIds.length
                ? supabaseAdmin.from('products')
                    .select('id, is_active')
                    .eq('company_id', companyId)
                    .in('id', productIds)
                : Promise.resolve({ data: [] })
        ]);

        const itemById = new Map((items || []).map(i => [i.id, i]));
        const productById = new Map((products || []).map(p => [p.id, p]));

        const accepted = [];
        const rejected = [];

        for (const [index, row] of rows.entries()) {
            const item = itemById.get(row?.kit_item_id);
            if (!item) { rejected.push({ index, error: 'Kit line not found.' }); continue; }

            const owner = item.repair_kits?.company_id;
            if (owner !== null && owner !== companyId) {
                rejected.push({ index, error: 'Kit line not found.' }); continue;
            }

            const isExcluded = row?.is_excluded === true;
            let productId = null;

            if (!isExcluded) {
                productId = row?.product_id || null;
                if (!productId) { rejected.push({ index, sku: item.sku, error: 'No product chosen.' }); continue; }
                const product = productById.get(productId);
                if (!product) { rejected.push({ index, sku: item.sku, error: 'Product not in this catalogue.' }); continue; }
                if (product.is_active === false) { rejected.push({ index, sku: item.sku, error: 'Product is not active.' }); continue; }
            }

            let quantity = null;
            if (row?.quantity !== undefined && row?.quantity !== null && row?.quantity !== '') {
                quantity = Number(row.quantity);
                if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) {
                    rejected.push({ index, sku: item.sku, error: 'Quantity out of range.' }); continue;
                }
            }

            accepted.push({
                company_id: companyId,
                kit_item_id: item.id,
                product_id: isExcluded ? null : productId,
                quantity,
                is_excluded: isExcluded,
                note: text(row?.note, 300) || null,
                updated_at: new Date().toISOString(),
                updated_by: req.admin.id
            });
        }

        if (accepted.length) {
            const { error } = await supabaseAdmin
                .from('kit_product_map')
                .upsert(accepted, { onConflict: 'company_id,kit_item_id' });
            if (error) throw error;

            await logAction(req.admin.id, 'kit_mapping_bulk', 'company', companyId,
                { saved: accepted.length, rejected: rejected.length }, req.ip);
        }

        res.status(accepted.length ? 200 : 400).json({
            message: `${accepted.length} of ${rows.length} mappings saved.`,
            saved: accepted.length,
            rejected
        });
    } catch (err) {
        console.error('Bulk kit mapping error:', err);
        res.status(500).json({ error: 'Failed to save those mappings.' });
    }
});

// ============================================================
// COMPANY-OWNED KITS
// ============================================================

/**
 * POST /kits
 * Body: { name, description, lines: [{ product_id, quantity, unit }] }
 * A kit built for one company from its own catalogue. Lines carry product_id
 * directly, so these need no mapping step.
 */
router.post('/', async (req, res) => {
    let kitId = null;
    try {
        const companyId = req.params.companyId;

        const name = text(req.body?.name, 120);
        if (!name) return res.status(400).json({ error: 'A kit name is required.' });

        const rawLines = Array.isArray(req.body?.lines) ? req.body.lines : [];
        if (rawLines.length === 0) return res.status(400).json({ error: 'A kit needs at least one line.' });
        if (rawLines.length > 200) return res.status(400).json({ error: 'Maximum 200 lines per kit.' });

        const productIds = rawLines.map(l => l?.product_id).filter(isValidUUID);
        const { data: products } = await supabaseAdmin
            .from('products')
            .select('id, sku, is_active')
            .eq('company_id', companyId)
            .in('id', productIds.length ? productIds : ['00000000-0000-0000-0000-000000000000']);

        const byId = new Map((products || []).map(p => [p.id, p]));

        const lines = [];
        for (const [index, raw] of rawLines.entries()) {
            const product = byId.get(raw?.product_id);
            if (!product) return res.status(400).json({ error: `Line ${index + 1}: product is not in this catalogue.` });
            if (product.is_active === false) return res.status(400).json({ error: `Line ${index + 1}: ${product.sku} is not active.` });

            const quantity = Number(raw?.quantity);
            if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) {
                return res.status(400).json({ error: `Line ${index + 1}: quantity must be a positive number.` });
            }

            lines.push({
                sku: product.sku || '',
                product_id: product.id,
                quantity,
                unit: text(raw?.unit, 20) || 'each',
                sort_order: index + 1
            });
        }

        const { data: kit, error: kitError } = await supabaseAdmin
            .from('repair_kits')
            .insert({
                company_id: companyId,
                name,
                description: text(req.body?.description, 500) || null,
                source: 'company',
                is_active: true,
                sort_order: 900
            })
            .select('id, name')
            .single();
        if (kitError) throw kitError;
        kitId = kit.id;

        const { error: lineError } = await supabaseAdmin
            .from('kit_items')
            .insert(lines.map(l => ({ ...l, kit_id: kit.id })));
        if (lineError) throw lineError;

        await logAction(req.admin.id, 'kit_created', 'company', companyId,
            { kit_id: kit.id, kit: kit.name, lines: lines.length }, req.ip);

        res.status(201).json({ message: `${kit.name} created.`, kit: { id: kit.id, name: kit.name, line_count: lines.length } });
    } catch (err) {
        console.error('Kit create error:', err);
        // A kit with no lines is a trap for whoever opens it next — remove it.
        if (kitId) {
            try { await supabaseAdmin.from('repair_kits').delete().eq('id', kitId); } catch (_) { /* noop */ }
        }
        res.status(500).json({ error: 'Failed to create that kit.' });
    }
});

/**
 * DELETE /kits/:kitId
 * Only a company's own kit, and only ever the definition — consumption history
 * keeps its own snapshot of the kit name, so past jobs are unaffected.
 */
router.delete('/:kitId', async (req, res) => {
    try {
        const companyId = req.params.companyId;
        const kitId = req.params.kitId;
        if (!isValidUUID(kitId)) return res.status(400).json({ error: 'Invalid kit id.' });

        const { data: kit } = await supabaseAdmin
            .from('repair_kits').select('id, name, company_id').eq('id', kitId).maybeSingle();
        if (!kit) return res.status(404).json({ error: 'Kit not found.' });
        if (kit.company_id !== companyId) {
            return res.status(403).json({ error: 'CHC master kits cannot be deleted from here — disable it for this company instead.' });
        }

        const { error } = await supabaseAdmin.from('repair_kits').delete().eq('id', kitId);
        if (error) throw error;

        await logAction(req.admin.id, 'kit_deleted', 'company', companyId, { kit: kit.name }, req.ip);
        res.json({ message: `${kit.name} deleted. Past jobs keep their history.` });
    } catch (err) {
        console.error('Kit delete error:', err);
        res.status(500).json({ error: 'Failed to delete that kit.' });
    }
});

module.exports = router;
module.exports.suggestProducts = suggestProducts;
module.exports.normalizeSku = normalizeSku;
module.exports.vendorOf = vendorOf;
