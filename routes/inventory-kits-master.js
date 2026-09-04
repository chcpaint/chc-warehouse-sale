/**
 * routes/inventory-kits-master.js
 *
 * refinishAI Inventory — master kit administration, mounted from server.js at
 *   /api/admin/kits
 *
 * routes/inventory-kits-admin.js (mounted per company) is where a shop's own
 * access and mapping live. This file is the other side of it: the kit and
 * its lines themselves -- creating a CHC master kit, editing what's on it,
 * curating the brand alternatives a line may be filled with, and switching a
 * kit on or off for many customers in one action instead of one company at a
 * time.
 *
 * Super-admin only, enforced here rather than by hiding a nav tab.
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requireSuperAdmin } = require('../middleware/auth');
const { stripHtml, isValidUUID } = require('../utils/sanitize');
const { suggestCrossoverAlternatives } = require('../utils/crossover-import');

const router = express.Router();

router.use(requireSuperAdmin);

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

async function loadKit(kitId) {
    if (!isValidUUID(kitId)) return null;
    const { data } = await supabaseAdmin
        .from('repair_kits')
        .select('id, name, description, source, sort_order, is_active, company_id, updated_at')
        .eq('id', kitId).maybeSingle();
    return data || null;
}

// ============================================================
// KIT LISTING AND CRUD
// ============================================================

/**
 * GET /kits
 * Every kit in the system, master or company-owned, with how many lines it
 * has and (for a master kit) how many customers currently have it switched
 * on -- the number that answers "is this kit actually in use."
 */
router.get('/', async (req, res) => {
    try {
        const [{ data: kits }, { data: items }, { data: access }, { data: companies }] = await Promise.all([
            supabaseAdmin.from('repair_kits')
                .select('id, name, description, source, sort_order, is_active, company_id, updated_at')
                .order('company_id', { ascending: true, nullsFirst: true })
                .order('name', { ascending: true }),
            supabaseAdmin.from('kit_items').select('id, kit_id'),
            supabaseAdmin.from('company_kit_access').select('kit_id, enabled').eq('enabled', true),
            supabaseAdmin.from('companies').select('id, name').eq('id', req.query.owner_company_id || '00000000-0000-0000-0000-000000000000')
        ]);

        const lineCountByKit = new Map();
        for (const item of items || []) lineCountByKit.set(item.kit_id, (lineCountByKit.get(item.kit_id) || 0) + 1);

        const enabledCountByKit = new Map();
        for (const a of access || []) enabledCountByKit.set(a.kit_id, (enabledCountByKit.get(a.kit_id) || 0) + 1);

        const ownerName = new Map((companies || []).map(c => [c.id, c.name]));

        const out = (kits || []).map(k => ({
            id: k.id,
            name: k.name,
            description: k.description || null,
            source: k.source || null,
            is_active: k.is_active,
            is_master: k.company_id === null,
            owner_company_id: k.company_id,
            owner_company_name: k.company_id ? (ownerName.get(k.company_id) || null) : null,
            line_count: lineCountByKit.get(k.id) || 0,
            companies_enabled: k.company_id === null ? (enabledCountByKit.get(k.id) || 0) : null,
            updated_at: k.updated_at
        }));

        res.json({ kits: out });
    } catch (err) {
        console.error('Master kit list error:', err);
        res.status(500).json({ error: 'Failed to load kits.' });
    }
});

/**
 * POST /kits
 * Body: { name, description, lines: [{ sku, quantity, unit }] }
 * A new CHC MASTER kit (company_id null), built from raw SKU strings rather
 * than a company's products -- exactly what the 15 imported kits look like.
 * Each company that turns it on maps its own lines afterward.
 */
router.post('/', async (req, res) => {
    let kitId = null;
    try {
        const name = text(req.body?.name, 120);
        if (!name) return res.status(400).json({ error: 'A kit name is required.' });

        const rawLines = Array.isArray(req.body?.lines) ? req.body.lines : [];
        if (rawLines.length === 0) return res.status(400).json({ error: 'A kit needs at least one line.' });
        if (rawLines.length > 200) return res.status(400).json({ error: 'Maximum 200 lines per kit.' });

        const lines = [];
        for (const [index, raw] of rawLines.entries()) {
            const sku = text(raw?.sku, 80);
            if (!sku) return res.status(400).json({ error: `Line ${index + 1}: a SKU is required.` });

            const quantity = Number(raw?.quantity);
            if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) {
                return res.status(400).json({ error: `Line ${index + 1}: quantity must be a positive number.` });
            }

            lines.push({ sku, quantity, unit: text(raw?.unit, 20) || 'each', sort_order: index + 1, needs_review: false });
        }

        const { data: kit, error: kitError } = await supabaseAdmin
            .from('repair_kits')
            .insert({
                company_id: null,
                name,
                description: text(req.body?.description, 500) || null,
                source: 'chc',
                is_active: true,
                sort_order: Number(req.body?.sort_order) || 500
            })
            .select('id, name')
            .single();
        if (kitError) throw kitError;
        kitId = kit.id;

        const { error: lineError } = await supabaseAdmin
            .from('kit_items')
            .insert(lines.map(l => ({ ...l, kit_id: kit.id })));
        if (lineError) throw lineError;

        await logAction(req.admin.id, 'master_kit_created', 'kit', kit.id, { kit: kit.name, lines: lines.length }, req.ip);

        res.status(201).json({ message: `${kit.name} created.`, kit: { id: kit.id, name: kit.name, line_count: lines.length } });
    } catch (err) {
        console.error('Master kit create error:', err);
        if (kitId) { try { await supabaseAdmin.from('repair_kits').delete().eq('id', kitId); } catch (_) { /* noop */ } }
        res.status(500).json({ error: 'Failed to create that kit.' });
    }
});

/**
 * GET /kits/:kitId
 * The kit's lines, each with its attached brand alternatives and, for a
 * line with none yet, ranked suggestions pulled from the crossover
 * reference sheet -- reviewed, never auto-attached.
 */
router.get('/:kitId', async (req, res) => {
    try {
        const kit = await loadKit(req.params.kitId);
        if (!kit) return res.status(404).json({ error: 'Kit not found.' });

        const { data: items } = await supabaseAdmin
            .from('kit_items')
            .select('id, sku, product_id, quantity, unit, sort_order, needs_review, ref_unit_price, ref_line_total, ref_source')
            .eq('kit_id', kit.id)
            .order('sort_order', { ascending: true });

        const kitItems = items || [];
        const { data: alternatives } = kitItems.length
            ? await supabaseAdmin.from('kit_item_alternatives')
                .select('id, kit_item_id, brand, brand_part_number, brand_name, speed, size, notes, is_active, sort_order, crossover_reference_id')
                .in('kit_item_id', kitItems.map(i => i.id))
                .order('sort_order', { ascending: true })
            : { data: [] };

        const altByItem = new Map();
        for (const a of alternatives || []) {
            if (!altByItem.has(a.kit_item_id)) altByItem.set(a.kit_item_id, []);
            altByItem.get(a.kit_item_id).push(a);
        }

        let referenceRows = [];
        const needSuggestions = kitItems.filter(i => (altByItem.get(i.id) || []).length === 0);
        if (needSuggestions.length) {
            const { data } = await supabaseAdmin
                .from('product_crossover_reference')
                .select('id, base_brand, base_part_number, base_name, alt_brand, alt_product_line, alt_name, alt_part_number, alt_speed, alt_size');
            referenceRows = data || [];
        }

        const lines = kitItems.map(item => {
            const refUnitPrice = item.ref_unit_price === null || item.ref_unit_price === undefined
                ? null : Number(item.ref_unit_price);
            // ref_line_total is stored as its own column (Skyline shows a
            // separate extended price per line, and the two can legitimately
            // round differently), but a manually-entered reference price has
            // no independent extended figure — quantity x price is exactly
            // what that column would say, so fall back to computing it.
            const refLineTotal = item.ref_line_total !== null && item.ref_line_total !== undefined
                ? Number(item.ref_line_total)
                : (refUnitPrice !== null ? Number((Number(item.quantity) * refUnitPrice).toFixed(4)) : null);

            return {
                id: item.id,
                sku: item.sku,
                product_id: item.product_id,
                quantity: Number(item.quantity),
                unit: item.unit || 'each',
                sort_order: item.sort_order,
                needs_review: item.needs_review === true,
                alternatives: altByItem.get(item.id) || [],
                suggested_alternatives: (altByItem.get(item.id) || []).length === 0
                    ? suggestCrossoverAlternatives(item.sku, referenceRows)
                    : [],
                // Reference-only figures — see migration 027. Never used to bill;
                // a second opinion so a total that has drifted is visible here,
                // at the source, rather than only downstream on a job.
                ref_unit_price: refUnitPrice,
                ref_line_total: refLineTotal,
                ref_source: item.ref_source || null
            };
        });

        const pricedLines = lines.filter(l => l.ref_line_total !== null);
        res.json({
            kit: { ...kit, is_master: kit.company_id === null },
            lines,
            reference_total: pricedLines.length === lines.length && lines.length > 0
                ? Number(pricedLines.reduce((s, l) => s + l.ref_line_total, 0).toFixed(4))
                : null,
            unpriced_line_count: lines.length - pricedLines.length
        });
    } catch (err) {
        console.error('Master kit detail error:', err);
        res.status(500).json({ error: 'Failed to load that kit.' });
    }
});

/**
 * PUT /kits/:kitId
 * Body: { name, description, is_active, sort_order }
 */
router.put('/:kitId', async (req, res) => {
    try {
        const kit = await loadKit(req.params.kitId);
        if (!kit) return res.status(404).json({ error: 'Kit not found.' });

        const name = text(req.body?.name, 120);
        if (!name) return res.status(400).json({ error: 'A kit name is required.' });

        const patch = {
            name,
            description: text(req.body?.description, 500) || null,
            updated_at: new Date().toISOString()
        };
        if (req.body?.is_active !== undefined) patch.is_active = req.body.is_active === true;
        if (req.body?.sort_order !== undefined) {
            const sort = Number(req.body.sort_order);
            if (Number.isFinite(sort)) patch.sort_order = sort;
        }

        const { data: saved, error } = await supabaseAdmin
            .from('repair_kits').update(patch).eq('id', kit.id)
            .select('id, name, description, is_active, sort_order').single();
        if (error) throw error;

        await logAction(req.admin.id, 'master_kit_updated', 'kit', kit.id, { kit: saved.name }, req.ip);
        res.json({ message: `${saved.name} saved.`, kit: saved });
    } catch (err) {
        console.error('Master kit update error:', err);
        res.status(500).json({ error: 'Failed to save that kit.' });
    }
});

/**
 * DELETE /kits/:kitId
 * A master kit (or an orphaned company kit) can be removed from here — the
 * per-company screen deliberately refuses to delete a master kit at all.
 * Past consumptions keep their own kit_name snapshot, so history is
 * unaffected either way.
 */
router.delete('/:kitId', async (req, res) => {
    try {
        const kit = await loadKit(req.params.kitId);
        if (!kit) return res.status(404).json({ error: 'Kit not found.' });

        const { error } = await supabaseAdmin.from('repair_kits').delete().eq('id', kit.id);
        if (error) throw error;

        await logAction(req.admin.id, 'master_kit_deleted', 'kit', kit.id, { kit: kit.name }, req.ip);
        res.json({ message: `${kit.name} deleted. Past jobs keep their history.` });
    } catch (err) {
        console.error('Master kit delete error:', err);
        res.status(500).json({ error: 'Failed to delete that kit.' });
    }
});

// ============================================================
// LINES
// ============================================================

/** POST /kits/:kitId/lines   Body: { sku, quantity, unit } */
router.post('/:kitId/lines', async (req, res) => {
    try {
        const kit = await loadKit(req.params.kitId);
        if (!kit) return res.status(404).json({ error: 'Kit not found.' });

        const sku = text(req.body?.sku, 80);
        if (!sku) return res.status(400).json({ error: 'A SKU is required.' });

        const quantity = Number(req.body?.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) {
            return res.status(400).json({ error: 'Quantity must be a positive number.' });
        }

        const { data: existing } = await supabaseAdmin
            .from('kit_items').select('sort_order').eq('kit_id', kit.id)
            .order('sort_order', { ascending: false }).limit(1);
        const nextSort = ((existing || [])[0]?.sort_order || 0) + 1;

        const insert = { kit_id: kit.id, sku, quantity, unit: text(req.body?.unit, 20) || 'each', sort_order: nextSort, needs_review: false };
        if (req.body?.ref_unit_price !== undefined && req.body?.ref_unit_price !== null && req.body?.ref_unit_price !== '') {
            const refPrice = Number(req.body.ref_unit_price);
            if (!Number.isFinite(refPrice) || refPrice < 0) {
                return res.status(400).json({ error: 'Reference price must be zero or a positive number.' });
            }
            insert.ref_unit_price = refPrice;
            insert.ref_line_total = Number((quantity * refPrice).toFixed(4));
            insert.ref_source = 'manual';
        }

        const { data: line, error } = await supabaseAdmin
            .from('kit_items')
            .insert(insert)
            .select('id, sku, quantity, unit, sort_order, ref_unit_price, ref_line_total, ref_source').single();
        if (error) throw error;

        await logAction(req.admin.id, 'master_kit_line_added', 'kit', kit.id, { kit: kit.name, sku }, req.ip);
        res.status(201).json({ message: 'Line added.', line });
    } catch (err) {
        console.error('Master kit line add error:', err);
        res.status(500).json({ error: 'Failed to add that line.' });
    }
});

/** PUT /kits/:kitId/lines/:lineId   Body: { sku, quantity, unit, needs_review, ref_unit_price } */
router.put('/:kitId/lines/:lineId', async (req, res) => {
    try {
        const { kitId, lineId } = req.params;
        if (!isValidUUID(lineId)) return res.status(400).json({ error: 'Invalid line id.' });

        const { data: existingLine } = await supabaseAdmin
            .from('kit_items').select('id, kit_id, quantity').eq('id', lineId).eq('kit_id', kitId).maybeSingle();
        if (!existingLine) return res.status(404).json({ error: 'Kit line not found.' });

        const patch = {};
        if (req.body?.sku !== undefined) {
            const sku = text(req.body.sku, 80);
            if (!sku) return res.status(400).json({ error: 'A SKU is required.' });
            patch.sku = sku;
        }
        if (req.body?.quantity !== undefined) {
            const quantity = Number(req.body.quantity);
            if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) {
                return res.status(400).json({ error: 'Quantity must be a positive number.' });
            }
            patch.quantity = quantity;
        }
        if (req.body?.unit !== undefined) patch.unit = text(req.body.unit, 20) || 'each';
        if (req.body?.needs_review !== undefined) patch.needs_review = req.body.needs_review === true;
        if (req.body?.sort_order !== undefined) {
            const sort = Number(req.body.sort_order);
            if (Number.isFinite(sort)) patch.sort_order = sort;
        }

        // A reference price entered here by hand, alongside (or instead of)
        // whatever Skyline originally supplied. Sending an explicit null
        // clears it, the same way clearing a mapping's product_id does
        // elsewhere in these kit screens. quantity x price is recomputed from
        // whichever quantity is in force after this same patch, so the two
        // numbers can never disagree.
        if (req.body?.ref_unit_price !== undefined) {
            if (req.body.ref_unit_price === null || req.body.ref_unit_price === '') {
                patch.ref_unit_price = null;
                patch.ref_line_total = null;
                patch.ref_source = null;
            } else {
                const refPrice = Number(req.body.ref_unit_price);
                if (!Number.isFinite(refPrice) || refPrice < 0) {
                    return res.status(400).json({ error: 'Reference price must be zero or a positive number.' });
                }
                const effectiveQty = patch.quantity !== undefined ? patch.quantity : Number(existingLine.quantity);
                patch.ref_unit_price = refPrice;
                patch.ref_line_total = Number((effectiveQty * refPrice).toFixed(4));
                patch.ref_source = 'manual';
            }
        }

        const { data: line, error } = await supabaseAdmin
            .from('kit_items').update(patch).eq('id', lineId)
            .select('id, sku, quantity, unit, sort_order, needs_review, ref_unit_price, ref_line_total, ref_source').single();
        if (error) throw error;

        res.json({ message: 'Line saved.', line });
    } catch (err) {
        console.error('Master kit line update error:', err);
        res.status(500).json({ error: 'Failed to save that line.' });
    }
});

/** DELETE /kits/:kitId/lines/:lineId */
router.delete('/:kitId/lines/:lineId', async (req, res) => {
    try {
        const { kitId, lineId } = req.params;
        if (!isValidUUID(lineId)) return res.status(400).json({ error: 'Invalid line id.' });

        const { data: existingLine } = await supabaseAdmin
            .from('kit_items').select('id, sku').eq('id', lineId).eq('kit_id', kitId).maybeSingle();
        if (!existingLine) return res.status(404).json({ error: 'Kit line not found.' });

        const { error } = await supabaseAdmin.from('kit_items').delete().eq('id', lineId);
        if (error) throw error;

        res.json({ message: `${existingLine.sku || 'Line'} removed.` });
    } catch (err) {
        console.error('Master kit line delete error:', err);
        res.status(500).json({ error: 'Failed to remove that line.' });
    }
});

// ============================================================
// BRAND ALTERNATIVES (the crossover dropdown, per line)
// ============================================================

/**
 * POST /kits/:kitId/lines/:lineId/alternatives
 * Body: { brand, brand_part_number, brand_name, speed, size, notes, crossover_reference_id }
 * Attaches one brand alternative to a line, reviewed by whoever is doing
 * this -- whether it came from a suggestion or was typed in from scratch.
 */
router.post('/:kitId/lines/:lineId/alternatives', async (req, res) => {
    try {
        const { kitId, lineId } = req.params;
        if (!isValidUUID(lineId)) return res.status(400).json({ error: 'Invalid line id.' });

        const { data: line } = await supabaseAdmin
            .from('kit_items').select('id').eq('id', lineId).eq('kit_id', kitId).maybeSingle();
        if (!line) return res.status(404).json({ error: 'Kit line not found.' });

        const brand = text(req.body?.brand, 60);
        const brandPart = text(req.body?.brand_part_number, 80);
        if (!brand || !brandPart) return res.status(400).json({ error: 'A brand and part number are required.' });

        let crossoverReferenceId = null;
        if (req.body?.crossover_reference_id) {
            if (!isValidUUID(req.body.crossover_reference_id)) return res.status(400).json({ error: 'Invalid reference id.' });
            crossoverReferenceId = req.body.crossover_reference_id;
        }

        const { data: alt, error } = await supabaseAdmin
            .from('kit_item_alternatives')
            .insert({
                kit_item_id: lineId,
                brand, brand_part_number: brandPart,
                brand_name: text(req.body?.brand_name, 200) || null,
                speed: text(req.body?.speed, 60) || null,
                size: text(req.body?.size, 60) || null,
                notes: text(req.body?.notes, 500) || null,
                crossover_reference_id: crossoverReferenceId,
                created_by: req.admin.id
            })
            .select('id, brand, brand_part_number, brand_name, speed, size, notes, is_active')
            .single();
        if (error) throw error;

        await logAction(req.admin.id, 'kit_alternative_added', 'kit_item', lineId, { brand, brand_part_number: brandPart }, req.ip);
        res.status(201).json({ message: `${brand} ${brandPart} attached.`, alternative: alt });
    } catch (err) {
        console.error('Kit alternative add error:', err);
        res.status(500).json({ error: 'Failed to attach that alternative.' });
    }
});

/** PUT /kits/alternatives/:altId   Body: any of the alternative's own fields */
router.put('/alternatives/:altId', async (req, res) => {
    try {
        const altId = req.params.altId;
        if (!isValidUUID(altId)) return res.status(400).json({ error: 'Invalid alternative id.' });

        const patch = { updated_at: new Date().toISOString() };
        if (req.body?.brand !== undefined) {
            const brand = text(req.body.brand, 60);
            if (!brand) return res.status(400).json({ error: 'A brand is required.' });
            patch.brand = brand;
        }
        if (req.body?.brand_part_number !== undefined) {
            const part = text(req.body.brand_part_number, 80);
            if (!part) return res.status(400).json({ error: 'A part number is required.' });
            patch.brand_part_number = part;
        }
        if (req.body?.brand_name !== undefined) patch.brand_name = text(req.body.brand_name, 200) || null;
        if (req.body?.speed !== undefined) patch.speed = text(req.body.speed, 60) || null;
        if (req.body?.size !== undefined) patch.size = text(req.body.size, 60) || null;
        if (req.body?.notes !== undefined) patch.notes = text(req.body.notes, 500) || null;
        if (req.body?.is_active !== undefined) patch.is_active = req.body.is_active === true;

        const { data: alt, error } = await supabaseAdmin
            .from('kit_item_alternatives').update(patch).eq('id', altId)
            .select('id, brand, brand_part_number, brand_name, speed, size, notes, is_active').single();
        if (error) throw error;
        if (!alt) return res.status(404).json({ error: 'Alternative not found.' });

        res.json({ message: 'Alternative saved.', alternative: alt });
    } catch (err) {
        console.error('Kit alternative update error:', err);
        res.status(500).json({ error: 'Failed to save that alternative.' });
    }
});

/** DELETE /kits/alternatives/:altId */
router.delete('/alternatives/:altId', async (req, res) => {
    try {
        const altId = req.params.altId;
        if (!isValidUUID(altId)) return res.status(400).json({ error: 'Invalid alternative id.' });

        const { error } = await supabaseAdmin.from('kit_item_alternatives').delete().eq('id', altId);
        if (error) throw error;
        res.json({ message: 'Alternative removed.' });
    } catch (err) {
        console.error('Kit alternative delete error:', err);
        res.status(500).json({ error: 'Failed to remove that alternative.' });
    }
});

// ============================================================
// CUSTOMER ACCESS, ACROSS MANY COMPANIES AT ONCE
// ============================================================

/**
 * GET /kits/:kitId/access
 * Every company, whether this (master) kit is on for them, and how far
 * their own mapping has gotten -- the screen "toggle some or all on" needs
 * a starting picture of.
 */
router.get('/:kitId/access', async (req, res) => {
    try {
        const kit = await loadKit(req.params.kitId);
        if (!kit) return res.status(404).json({ error: 'Kit not found.' });
        if (kit.company_id !== null) return res.status(400).json({ error: 'Only a CHC master kit has customer access to manage.' });

        const [{ data: companies }, { data: access }, { data: items }] = await Promise.all([
            supabaseAdmin.from('companies').select('id, name, slug, is_active').order('name', { ascending: true }),
            supabaseAdmin.from('company_kit_access').select('company_id, enabled').eq('kit_id', kit.id),
            supabaseAdmin.from('kit_items').select('id').eq('kit_id', kit.id)
        ]);

        const itemIds = (items || []).map(i => i.id);
        const { data: maps } = itemIds.length
            ? await supabaseAdmin.from('kit_product_map').select('company_id, product_id, is_excluded').in('kit_item_id', itemIds)
            : { data: [] };

        const enabledBy = new Map((access || []).map(a => [a.company_id, a.enabled]));
        const resolvedByCompany = new Map();
        for (const m of maps || []) {
            if (m.is_excluded || m.product_id) resolvedByCompany.set(m.company_id, (resolvedByCompany.get(m.company_id) || 0) + 1);
        }

        const rows = (companies || []).map(c => ({
            company_id: c.id,
            company_name: c.name,
            slug: c.slug,
            is_active: c.is_active,
            enabled: enabledBy.get(c.id) === true,
            lines_resolved: resolvedByCompany.get(c.id) || 0,
            line_count: itemIds.length
        }));

        res.json({ kit: { id: kit.id, name: kit.name }, companies: rows });
    } catch (err) {
        console.error('Kit access list error:', err);
        res.status(500).json({ error: 'Failed to load customer access.' });
    }
});

/**
 * PUT /kits/:kitId/access/bulk
 * Body: { company_ids: [...], enabled: true|false }
 * Turns a master kit on or off for every listed company in one action --
 * "some or all on for their accounts," rather than one company at a time.
 */
router.put('/:kitId/access/bulk', async (req, res) => {
    try {
        const kit = await loadKit(req.params.kitId);
        if (!kit) return res.status(404).json({ error: 'Kit not found.' });
        if (kit.company_id !== null) return res.status(400).json({ error: 'Only a CHC master kit has customer access to manage.' });

        const companyIds = Array.isArray(req.body?.company_ids) ? req.body.company_ids.filter(isValidUUID) : [];
        if (companyIds.length === 0) return res.status(400).json({ error: 'No customers selected.' });
        if (companyIds.length > 2000) return res.status(400).json({ error: 'Too many customers in one request.' });

        const enabled = req.body?.enabled === true;

        const { data: real } = await supabaseAdmin.from('companies').select('id').in('id', companyIds);
        const realIds = new Set((real || []).map(c => c.id));
        const rows = companyIds.filter(id => realIds.has(id)).map(id => ({ company_id: id, kit_id: kit.id, enabled }));

        if (rows.length === 0) return res.status(400).json({ error: 'None of those customers were found.' });

        const { error } = await supabaseAdmin
            .from('company_kit_access').upsert(rows, { onConflict: 'company_id,kit_id' });
        if (error) throw error;

        await logAction(req.admin.id, enabled ? 'kit_bulk_enabled' : 'kit_bulk_disabled', 'kit', kit.id,
            { kit: kit.name, companies: rows.length }, req.ip);

        res.json({ message: `${kit.name} ${enabled ? 'enabled' : 'disabled'} for ${rows.length} customer(s).`, applied: rows.length });
    } catch (err) {
        console.error('Kit bulk access error:', err);
        res.status(500).json({ error: 'Failed to update customer access.' });
    }
});

module.exports = router;
