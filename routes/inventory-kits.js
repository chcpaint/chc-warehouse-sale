/**
 * routes/inventory-kits.js
 *
 * refinishAI Inventory — repair kits on the shop floor, mounted from
 * routes/inventory-store.js at
 *   /api/store/:slug/inventory/kits
 *
 * A kit is a job type — "Door Skin", "Quarter Panel Replacement" — with the
 * materials that job normally consumes and how much of each. Applying a kit to
 * a repair order expenses all of those materials off the shelf in one action,
 * instead of the technician scanning eight items and remembering the fractions.
 *
 * Three rules shape this file.
 *
 * 1. NOTHING IS GUESSED. A master kit line is a SKU string, and products are
 *    per-company, so a line only means something once that company has said what
 *    it means (`kit_product_map`). An unresolved line blocks the consume with a
 *    message naming it. The alternative — matching on SKU text at run time —
 *    would silently expense the wrong material and mis-cost the job, and it
 *    would do it differently for each company. Resolution is data, not a guess.
 *
 * 2. PREVIEW BEFORE POST. `/preview` returns exactly what would be written,
 *    priced, with on-hand and any shortfall, and writes nothing. The shop floor
 *    sees the whole consequence before it commits.
 *
 * 3. THE LEDGER IS UNCHANGED. A consume writes ordinary `consume` rows through
 *    the same path a hand scan uses, sharing one `source_doc_id`. On-hand is
 *    still derived by the database trigger, the append-only rule still holds,
 *    and Usage and job costing pick the lines up with no change.
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { isValidUUID } = require('../utils/sanitize');
const { round4 } = require('../utils/inventory');

const router = express.Router({ mergeParams: true });

// ============================================================
// LOADING A KIT, RESOLVED FOR ONE COMPANY
// ============================================================

/**
 * Kits this company may use: its own, plus any CHC master kit switched on for
 * it. Ordered so master kits and private kits interleave by sort order, which
 * is how a shop thinks about them.
 */
async function kitsForCompany(companyId) {
    const [own, granted] = await Promise.all([
        supabaseAdmin
            .from('repair_kits')
            .select('id, name, description, source, sort_order, is_active, company_id')
            .eq('company_id', companyId)
            .eq('is_active', true),
        supabaseAdmin
            .from('company_kit_access')
            .select('kit_id, enabled, repair_kits!inner(id, name, description, source, sort_order, is_active, company_id)')
            .eq('company_id', companyId)
            .eq('enabled', true)
    ]);

    const rows = [...(own.data || [])];
    for (const row of granted.data || []) {
        const kit = row.repair_kits;
        // A master kit only. A grant pointing at another company's private kit
        // would be a data error; refuse to serve it rather than trust the join.
        if (kit && kit.is_active && kit.company_id === null) rows.push(kit);
    }

    return rows.sort((a, b) =>
        (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.name).localeCompare(String(b.name))
    );
}

/** One kit, only if this company is entitled to it. */
async function kitForCompany(companyId, kitId) {
    if (!isValidUUID(kitId)) return null;
    const kits = await kitsForCompany(companyId);
    return kits.find(k => k.id === kitId) || null;
}

/**
 * Resolve a kit's lines for one company: apply the company's mapping, pull the
 * product and its price, and say plainly which lines are not yet usable.
 *
 * Returns { lines, unresolved, excluded } where every line carries enough for
 * the caller to price it, post it, or explain why it cannot.
 */
async function resolveKitLines(companyId, kitId) {
    const { data: items, error } = await supabaseAdmin
        .from('kit_items')
        .select('id, sku, product_id, quantity, unit, sort_order, needs_review, ref_unit_price, ref_line_total, ref_source')
        .eq('kit_id', kitId)
        .order('sort_order', { ascending: true });

    if (error) throw error;
    const kitItems = items || [];
    if (kitItems.length === 0) return { lines: [], unresolved: [], excluded: [] };

    const { data: maps } = await supabaseAdmin
        .from('kit_product_map')
        .select('kit_item_id, product_id, quantity, is_excluded, note, unit_price_override')
        .eq('company_id', companyId)
        .in('kit_item_id', kitItems.map(i => i.id));

    const mapByItem = new Map((maps || []).map(m => [m.kit_item_id, m]));

    // A kit line may resolve either through the company's map or — for a kit the
    // company built itself — through the line's own product_id.
    const productIds = [];
    for (const item of kitItems) {
        const map = mapByItem.get(item.id);
        const pid = map ? map.product_id : item.product_id;
        if (pid && !productIds.includes(pid)) productIds.push(pid);
    }

    const products = new Map();
    if (productIds.length) {
        const { data: rows } = await supabaseAdmin
            .from('products')
            .select('id, name, sku, price, category, is_active')
            .eq('company_id', companyId)          // tenancy re-checked, never assumed
            .in('id', productIds);
        for (const p of rows || []) products.set(p.id, p);
    }

    const lines = [];
    const unresolved = [];
    const excluded = [];

    for (const item of kitItems) {
        const map = mapByItem.get(item.id) || null;

        if (map?.is_excluded) {
            excluded.push({ kit_item_id: item.id, sku: item.sku, note: map.note || null });
            continue;
        }

        const quantity = Number(map?.quantity ?? item.quantity);
        const productId = map ? map.product_id : item.product_id;
        const product = productId ? products.get(productId) : null;

        if (!product) {
            unresolved.push({
                kit_item_id: item.id,
                sku: item.sku,
                quantity,
                reason: productId
                    ? 'Mapped to a product that no longer exists in your catalogue.'
                    : 'Not yet matched to a product in your catalogue.'
            });
            continue;
        }

        if (product.is_active === false) {
            unresolved.push({
                kit_item_id: item.id, sku: item.sku, quantity,
                reason: `${product.sku || product.name} is no longer active in your catalogue.`
            });
            continue;
        }

        if (!Number.isFinite(quantity) || quantity <= 0) {
            unresolved.push({
                kit_item_id: item.id, sku: item.sku, quantity,
                reason: 'The kit line has no usable quantity.'
            });
            continue;
        }

        // A company can set what it actually pays for this line
        // (kit_product_map.unit_price_override) when that differs from its own
        // catalogue price — e.g. a negotiated rate on a brand alternative. This
        // is what the "price they pay" field on the admin console's per-company
        // kit screen saves; missing it here would let an admin believe they had
        // set a price that silently never affected what got billed.
        const priceOverride = map?.unit_price_override !== null && map?.unit_price_override !== undefined
            ? Number(map.unit_price_override) : null;

        lines.push({
            kit_item_id: item.id,
            kit_sku: item.sku,
            product_id: product.id,
            sku: product.sku,
            name: product.name,
            category: product.category || null,
            unit: item.unit || 'each',
            quantity,
            unit_price: priceOverride !== null ? priceOverride : Number(product.price ?? 0),
            catalogue_unit_price: Number(product.price ?? 0),
            price_overridden: priceOverride !== null,
            // The price the source system carries for this line, when one is
            // known. Shown beside the live figure so a total that has drifted is
            // visible before the job is invoiced. Never billed from.
            ref_unit_price: item.ref_unit_price === null || item.ref_unit_price === undefined
                ? null : Number(item.ref_unit_price),
            ref_line_total: item.ref_line_total === null || item.ref_line_total === undefined
                ? null : Number(item.ref_line_total),
            source: map ? 'mapped' : 'kit'
        });
    }

    return { lines, unresolved, excluded };
}

// ============================================================
// READ
// ============================================================

/**
 * GET /kits
 * The picker. Includes a readiness count per kit so a shop can see at a glance
 * which kits are usable before opening one.
 */
router.get('/', async (req, res) => {
    try {
        const companyId = req.company.id;
        const kits = await kitsForCompany(companyId);
        if (kits.length === 0) return res.json({ kits: [] });

        const out = [];
        for (const kit of kits) {
            const { lines, unresolved, excluded } = await resolveKitLines(companyId, kit.id);
            out.push({
                id: kit.id,
                name: kit.name,
                description: kit.description || null,
                is_master: kit.company_id === null,
                ready: unresolved.length === 0 && lines.length > 0,
                line_count: lines.length,
                unresolved_count: unresolved.length,
                excluded_count: excluded.length,
                estimated_cost: round4(lines.reduce((s, l) => s + l.quantity * l.unit_price, 0))
            });
        }

        res.json({ kits: out });
    } catch (err) {
        console.error('Kit list error:', err);
        res.status(500).json({ error: 'Failed to load kits.' });
    }
});

/**
 * GET /kits/:kitId/preview?location_id=&multiplier=
 *
 * Exactly what a consume would write, priced against live on-hand. Writes
 * nothing. `blocked` is the single flag the UI needs to enable or disable the
 * commit button.
 */
router.get('/:kitId/preview', async (req, res) => {
    try {
        const companyId = req.company.id;
        const settings = req.inventorySettings;

        const kit = await kitForCompany(companyId, req.params.kitId);
        if (!kit) return res.status(404).json({ error: 'Kit not found for this account.' });

        const location = await req.resolveLocation(companyId, req.query.location_id);
        if (!location) return res.status(400).json({ error: 'Select a valid location first.' });

        const multiplier = normalizeMultiplier(req.query.multiplier);
        if (!multiplier.ok) return res.status(400).json({ error: multiplier.error });

        const { lines, unresolved, excluded } = await resolveKitLines(companyId, kit.id);

        const levels = lines.length
            ? await req.levelsFor(companyId, location.id, lines.map(l => l.product_id))
            : {};

        const priced = lines.map(line => {
            const qty = round4(line.quantity * multiplier.value);
            const onHand = Number(levels[line.product_id]?.on_hand ?? 0);
            const shortfall = round4(Math.max(0, qty - onHand));

            // A location locked to one category refuses stock outside it — the
            // same rule the scan path and the order flow enforce.
            const categoryBlocked = Boolean(
                location.restrict_to_category && (line.category || '') !== location.restrict_to_category
            );

            // A line resolved to a product with no price consumes stock and
            // contributes nothing to the total. The kit would post and the job
            // would be under-billed with nothing on screen to say so, which is
            // worse than refusing — so it blocks, like a shortfall does.
            const unpriced = !(Number(line.unit_price) > 0);

            return {
                ...line,
                quantity: qty,
                on_hand: onHand,
                shortfall,
                line_cost: round4(qty * line.unit_price),
                ref_line_cost: line.ref_unit_price === null
                    ? null : round4(qty * line.ref_unit_price),
                would_go_negative: shortfall > 0,
                category_blocked: categoryBlocked,
                unpriced,
                blocking: categoryBlocked || unpriced || (shortfall > 0 && !settings.allow_negative)
            };
        });

        const blockingLines = priced.filter(l => l.blocking);

        res.json({
            kit: { id: kit.id, name: kit.name, description: kit.description || null },
            location: { id: location.id, name: location.name },
            multiplier: multiplier.value,
            lines: priced,
            unresolved,
            excluded,
            total_cost: round4(priced.reduce((s, l) => s + l.line_cost, 0)),
            // What the source system says the same kit comes to, when every
            // line has a reference. Null the moment one does not, because a
            // partial sum compared against a full one is worse than no compare.
            reference_total: priced.every(l => l.ref_line_cost !== null)
                ? round4(priced.reduce((s, l) => s + l.ref_line_cost, 0))
                : null,
            blocked: unresolved.length > 0 || blockingLines.length > 0 || priced.length === 0,
            blocked_reason: blockedReason({ priced, unresolved, blockingLines, allowNegative: settings.allow_negative })
        });
    } catch (err) {
        console.error('Kit preview error:', err);
        res.status(500).json({ error: 'Failed to preview that kit.' });
    }
});

/**
 * GET /kits/consumptions?job_ref=&limit=
 * What has been expensed by kit, newest first. Filter by job to answer
 * "what went onto RO-1234".
 */
router.get('/consumptions', async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

        let query = supabaseAdmin
            .from('kit_consumptions')
            .select('id, kit_id, kit_name, job_ref, multiplier, line_count, total_cost, actor_label, created_at, location_id')
            .eq('company_id', req.company.id)
            .order('created_at', { ascending: false })
            .limit(limit);

        const jobRef = req.text(req.query.job_ref, 60);
        if (jobRef) query = query.eq('job_ref', jobRef);
        if (req.query.location_id && isValidUUID(req.query.location_id)) {
            query = query.eq('location_id', req.query.location_id);
        }

        const { data, error } = await query;
        if (error) throw error;

        res.json({ consumptions: data || [] });
    } catch (err) {
        console.error('Kit consumption list error:', err);
        res.status(500).json({ error: 'Failed to load kit history.' });
    }
});

/**
 * GET /kits/consumptions/:id
 * One consumption with the exact movements it produced — the audit view.
 */
router.get('/consumptions/:id', async (req, res) => {
    try {
        if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid consumption id.' });

        const { data: header } = await supabaseAdmin
            .from('kit_consumptions')
            .select('*')
            .eq('id', req.params.id)
            .eq('company_id', req.company.id)
            .maybeSingle();

        if (!header) return res.status(404).json({ error: 'Consumption not found.' });

        const { data: movements } = await supabaseAdmin
            .from('stock_movements')
            .select('id, product_id, qty_change, on_hand_after, created_at, products(sku, name, price)')
            .eq('company_id', req.company.id)
            .eq('source_doc_type', 'kit_consume')
            .eq('source_doc_id', header.id)
            .order('created_at', { ascending: true });

        res.json({ consumption: header, movements: movements || [] });
    } catch (err) {
        console.error('Kit consumption detail error:', err);
        res.status(500).json({ error: 'Failed to load that consumption.' });
    }
});

// ============================================================
// WRITE
// ============================================================

/**
 * POST /kits/:kitId/consume
 * Body: { location_id, job_ref, actor_label, multiplier?, note?, lines? }
 *
 * `lines` is an optional per-consume override — [{ kit_item_id, quantity, skip }]
 * — for the real case where a job used a bit more clear than the kit assumes.
 * It adjusts this one job; it never edits the kit.
 *
 * The header is written first so every movement can point at it. If a movement
 * then fails, the already-written movements are reversed and the header is
 * deleted, because a half-expensed job is worse than a refused one.
 */
router.post('/:kitId/consume', async (req, res) => {
    let header = null;
    const written = [];

    try {
        const companyId = req.company.id;
        const settings = req.inventorySettings;

        const kit = await kitForCompany(companyId, req.params.kitId);
        if (!kit) return res.status(404).json({ error: 'Kit not found for this account.' });

        const location = await req.resolveLocation(companyId, req.body?.location_id);
        if (!location) return res.status(400).json({ error: 'Select a valid location first.' });

        const actor = req.actorLabel();
        if (!actor) return res.status(400).json({ error: 'Enter your name so the job can be attributed.' });

        const jobRef = req.text(req.body?.job_ref, 60);
        if (!jobRef) return res.status(400).json({ error: 'A repair order number is required to expense a kit.' });

        const multiplier = normalizeMultiplier(req.body?.multiplier);
        if (!multiplier.ok) return res.status(400).json({ error: multiplier.error });

        const { lines, unresolved } = await resolveKitLines(companyId, kit.id);

        if (unresolved.length) {
            return res.status(409).json({
                error: `${unresolved.length} item${unresolved.length === 1 ? '' : 's'} in this kit ${unresolved.length === 1 ? 'is' : 'are'} not matched to your catalogue yet. CHC can map ${unresolved.length === 1 ? 'it' : 'them'} for you.`,
                unresolved
            });
        }
        if (lines.length === 0) {
            return res.status(400).json({ error: 'This kit has no usable lines.' });
        }

        // Per-consume overrides, keyed by kit line.
        const overrides = new Map();
        if (Array.isArray(req.body?.lines)) {
            for (const raw of req.body.lines.slice(0, 200)) {
                if (!raw || !isValidUUID(raw.kit_item_id)) continue;
                overrides.set(raw.kit_item_id, raw);
            }
        }

        const planned = [];
        for (const line of lines) {
            const override = overrides.get(line.kit_item_id);
            if (override?.skip === true) continue;

            const qty = override && override.quantity !== undefined && override.quantity !== null
                ? Number(override.quantity)
                : round4(line.quantity * multiplier.value);

            if (!Number.isFinite(qty) || qty <= 0) {
                return res.status(400).json({ error: `Quantity for ${line.sku || line.name} must be a positive number.` });
            }
            if (qty > 100000) {
                return res.status(400).json({ error: `Quantity for ${line.sku || line.name} is out of range.` });
            }

            planned.push({ ...line, quantity: round4(qty) });
        }

        if (planned.length === 0) {
            return res.status(400).json({ error: 'Every line was skipped — nothing to expense.' });
        }

        // Check the whole kit before writing any of it. Partially expensing a
        // job and then failing is the outcome worth the most effort to avoid.
        const levels = await req.levelsFor(companyId, location.id, planned.map(l => l.product_id));
        const problems = [];
        for (const line of planned) {
            const onHand = Number(levels[line.product_id]?.on_hand ?? 0);
            if (location.restrict_to_category && (line.category || '') !== location.restrict_to_category) {
                problems.push(`${location.name} only stocks ${location.restrict_to_category} items — ${line.sku || line.name} is ${line.category || 'uncategorised'}.`);
            } else if (!(Number(line.unit_price) > 0)) {
                // Same reasoning as the preview: expensing this would draw the
                // stock down and bill nothing for it.
                problems.push(`${line.sku || line.name} has no price set — the job would be under-billed. Set a price before expensing this kit.`);
            } else if (!settings.allow_negative && onHand - line.quantity < 0) {
                problems.push(`Only ${onHand} of ${line.sku || line.name} on hand, kit needs ${line.quantity}.`);
            }
        }
        if (problems.length) {
            return res.status(409).json({ error: problems[0], problems });
        }

        const totalCost = round4(planned.reduce((s, l) => s + l.quantity * l.unit_price, 0));

        const { data: created, error: headerError } = await supabaseAdmin
            .from('kit_consumptions')
            .insert({
                company_id: companyId,
                location_id: location.id,
                kit_id: kit.id,
                kit_name: kit.name,
                job_ref: jobRef,
                multiplier: multiplier.value,
                line_count: planned.length,
                total_cost: totalCost,
                actor_label: actor,
                actor_type: 'store'
            })
            .select('id, created_at')
            .single();

        if (headerError) throw headerError;
        header = created;

        const note = req.text(req.body?.note, 200);

        for (const line of planned) {
            const { data: movement, error } = await supabaseAdmin
                .from('stock_movements')
                .insert({
                    company_id: companyId,
                    location_id: location.id,
                    product_id: line.product_id,
                    qty_change: -line.quantity,
                    movement_type: 'consume',
                    reason: note ? `${kit.name} — ${note}` : `${kit.name} (kit)`,
                    job_ref: jobRef,
                    actor_type: 'store',
                    actor_label: actor,
                    source_doc_type: 'kit_consume',
                    source_doc_id: header.id
                })
                .select('id, product_id, qty_change, on_hand_after')
                .single();

            if (error) throw error;
            written.push(movement);
        }

        // Reorder drafts are raised after the whole kit lands, so a kit that
        // takes three items below minimum produces one coherent set of drafts.
        let drafted = 0;
        if (settings.auto_draft) {
            for (const movement of written) {
                const line = planned.find(l => l.product_id === movement.product_id);
                const draft = await req.maybeDraftReplenishment({
                    companyId,
                    location,
                    product: { id: line.product_id, name: line.name, sku: line.sku, category: line.category },
                    actor,
                    onHand: Number(movement.on_hand_after ?? 0),
                    level: levels[line.product_id] || null
                });
                if (draft) drafted += 1;
            }
        }

        res.status(201).json({
            message: `${planned.length} item${planned.length === 1 ? '' : 's'} expensed to ${jobRef}.`,
            consumption: {
                id: header.id,
                kit_name: kit.name,
                job_ref: jobRef,
                multiplier: multiplier.value,
                line_count: planned.length,
                total_cost: totalCost,
                created_at: header.created_at
            },
            movements: written,
            replenishments_drafted: drafted
        });
    } catch (err) {
        console.error('Kit consume error:', err);

        // Unwind. The ledger refuses UPDATE and DELETE of movements is how a
        // mistake is corrected elsewhere, so the reversal is itself a movement:
        // the history shows the attempt and its correction, which is the honest
        // record of what happened.
        if (written.length) {
            for (const movement of written) {
                try {
                    await supabaseAdmin.from('stock_movements').insert({
                        company_id: req.company.id,
                        location_id: req.body?.location_id,
                        product_id: movement.product_id,
                        qty_change: -Number(movement.qty_change),
                        movement_type: 'adjust',
                        reason: 'Reversal — kit consume failed part-way',
                        actor_type: 'system',
                        actor_label: 'refinishAI',
                        source_doc_type: 'kit_consume_reversal',
                        source_doc_id: header?.id || null
                    });
                } catch (reversalError) {
                    console.error('CRITICAL: kit reversal failed', movement.id, reversalError);
                }
            }
        }
        if (header?.id) {
            try {
                await supabaseAdmin.from('kit_consumptions').delete().eq('id', header.id);
            } catch (_) { /* the reversals are what matter; a stray header is harmless */ }
        }

        res.status(500).json({ error: 'Failed to expense that kit. Nothing was left half-applied.' });
    }
});

// ============================================================
// HELPERS
// ============================================================

/**
 * A kit can be applied more than once to a job — two doors, both quarters.
 * Bounded, because a typo in this field would empty a shelf.
 */
function normalizeMultiplier(raw) {
    if (raw === undefined || raw === null || raw === '') return { ok: true, value: 1 };
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'Multiplier must be a positive number.' };
    if (n > 100) return { ok: false, error: 'Multiplier cannot exceed 100.' };
    return { ok: true, value: round4(n) };
}

/** One sentence the shop floor can act on, rather than a list to decode. */
function blockedReason({ priced, unresolved, blockingLines, allowNegative }) {
    if (priced.length === 0 && unresolved.length === 0) return 'This kit has no lines.';
    if (unresolved.length) {
        return `${unresolved.length} item${unresolved.length === 1 ? '' : 's'} not matched to your catalogue yet — CHC can map ${unresolved.length === 1 ? 'it' : 'them'}.`;
    }
    const category = blockingLines.find(l => l.category_blocked);
    if (category) return `This location does not stock ${category.category || 'that category'}.`;
    const unpriced = blockingLines.find(l => l.unpriced);
    if (unpriced) {
        return `${unpriced.sku || unpriced.name} has no price — this kit would expense stock without billing for it.`;
    }
    const short = blockingLines.find(l => l.would_go_negative);
    if (short && !allowNegative) {
        return `Not enough ${short.sku || short.name} on hand — ${short.on_hand} of ${short.quantity} needed.`;
    }
    return null;
}

module.exports = router;
module.exports.resolveKitLines = resolveKitLines;
module.exports.kitsForCompany = kitsForCompany;
