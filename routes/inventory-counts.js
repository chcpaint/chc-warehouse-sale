/**
 * routes/inventory-counts.js
 *
 * refinishAI Inventory, phase 4 — cycle counts and inter-location transfers.
 * Mounted from routes/inventory-store.js at
 *   /api/store/:slug/inventory/counts
 *   /api/store/:slug/inventory/transfers
 *
 * A cycle count is a session, not a movement. Staff count a shelf over minutes
 * or hours; nothing touches stock until a supervisor reviews the variances and
 * commits. An abandoned count therefore leaves the ledger untouched, and a
 * committed one writes one `count` movement per genuine variance, so the audit
 * trail shows what was actually wrong rather than a wall of no-op rows.
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { stripHtml, isValidUUID } = require('../utils/sanitize');
const { canonicalBarcode, round4 } = require('../utils/inventory');

const router = express.Router({ mergeParams: true });

// requireCompanyAuth and requireInventoryEnabled are applied by the parent
// router before this file is reached; req.company and req.inventorySettings
// are therefore always present.

function text(v, max = 200) {
    return stripHtml(String(v === undefined || v === null ? '' : v)).trim().slice(0, max);
}

function actorLabel(req) {
    return text(req.body?.actor_label, 80) || null;
}

async function resolveLocation(companyId, locationId) {
    if (!locationId || !isValidUUID(locationId)) return null;
    const { data } = await supabaseAdmin
        .from('company_locations')
        .select('id, name, city, restrict_to_category')
        .eq('id', locationId).eq('company_id', companyId).eq('is_active', true).maybeSingle();
    return data || null;
}

// ============================================================
// CYCLE COUNTS
// ============================================================

/**
 * POST /counts
 * Open a counting session.
 * Body: { location_id, name?, scope_type?, scope_value?, actor_label }
 */
router.post('/counts', async (req, res) => {
    try {
        const companyId = req.company.id;
        const location = await resolveLocation(companyId, req.body?.location_id);
        if (!location) return res.status(400).json({ error: 'Select a valid location first.' });

        const actor = actorLabel(req);
        if (!actor) return res.status(400).json({ error: 'Enter your name to start a count.' });

        const scopeType = ['all', 'category', 'bin', 'selection'].includes(req.body?.scope_type)
            ? req.body.scope_type : 'all';
        const scopeValue = scopeType === 'all' ? null : text(req.body?.scope_value, 80);
        if (scopeType !== 'all' && !scopeValue) {
            return res.status(400).json({ error: `A ${scopeType} is required for that count scope.` });
        }

        const { data, error } = await supabaseAdmin
            .from('inventory_count_sessions')
            .insert({
                company_id: companyId,
                location_id: location.id,
                name: text(req.body?.name, 80) || defaultCountName(scopeType, scopeValue),
                scope_type: scopeType,
                scope_value: scopeValue,
                status: 'open',
                opened_by: actor,
                notes: text(req.body?.notes, 300) || null
            })
            .select()
            .single();

        if (error) {
            // The partial unique index means a second open count on the same
            // shelf is refused rather than allowed to race the first.
            if (String(error.code) === '23505' || /duplicate key/i.test(error.message || '')) {
                const { data: open } = await supabaseAdmin
                    .from('inventory_count_sessions')
                    .select('id, name, opened_by, created_at')
                    .eq('location_id', location.id).eq('status', 'open').maybeSingle();
                return res.status(409).json({
                    error: `${location.name} already has a count open${open?.opened_by ? `, started by ${open.opened_by}` : ''}. Finish or cancel it first.`,
                    open_session: open || null
                });
            }
            throw error;
        }

        res.status(201).json({ session: data });
    } catch (err) {
        console.error('Open count error:', err);
        res.status(500).json({ error: 'Failed to start that count.' });
    }
});

function defaultCountName(scopeType, scopeValue) {
    if (scopeType === 'category') return `Count — ${scopeValue}`;
    if (scopeType === 'bin') return `Count — bin ${scopeValue}`;
    if (scopeType === 'selection') return 'Spot count';
    return 'Full count';
}

/** GET /counts?location_id=&status= — sessions, newest first. */
router.get('/counts', async (req, res) => {
    try {
        const companyId = req.company.id;
        const location = await resolveLocation(companyId, req.query.location_id);
        if (!location) return res.status(400).json({ error: 'Select a valid location first.' });

        let query = supabaseAdmin
            .from('inventory_count_sessions')
            .select('*')
            .eq('company_id', companyId)
            .eq('location_id', location.id)
            .order('created_at', { ascending: false })
            .limit(50);

        if (req.query.status && ['open', 'committed', 'cancelled'].includes(req.query.status)) {
            query = query.eq('status', req.query.status);
        }

        const { data, error } = await query;
        if (error) throw error;
        res.json({ sessions: data || [] });
    } catch (err) {
        console.error('List counts error:', err);
        res.status(500).json({ error: 'Failed to load counts.' });
    }
});

/** GET /counts/:id — a session with its lines and live variances. */
router.get('/counts/:id', async (req, res) => {
    try {
        const session = await loadSession(req.company.id, req.params.id);
        if (!session) return res.status(404).json({ error: 'Count not found.' });

        const { data: lines } = await supabaseAdmin
            .from('inventory_count_lines')
            .select('*')
            .eq('session_id', session.id)
            .order('created_at', { ascending: false });

        // Re-read on-hand so an open session shows the variance as it stands
        // now, not as it stood when the item was counted.
        const productIds = (lines || []).map(l => l.product_id);
        const current = {};
        if (productIds.length) {
            const { data: levels } = await supabaseAdmin
                .from('inventory_levels')
                .select('product_id, on_hand')
                .eq('location_id', session.location_id)
                .in('product_id', productIds);
            for (const l of levels || []) current[l.product_id] = Number(l.on_hand);
        }

        const enriched = (lines || []).map(l => {
            const onHand = current[l.product_id] ?? Number(l.expected_qty ?? 0);
            return { ...l, current_on_hand: onHand, live_variance: round4(Number(l.counted_qty) - onHand) };
        });

        res.json({
            session,
            lines: enriched,
            summary: {
                counted: enriched.length,
                variances: enriched.filter(l => Number(l.live_variance) !== 0).length,
                net_units: round4(enriched.reduce((s, l) => s + Number(l.live_variance), 0))
            }
        });
    } catch (err) {
        console.error('Read count error:', err);
        res.status(500).json({ error: 'Failed to load that count.' });
    }
});

async function loadSession(companyId, id, statuses) {
    if (!isValidUUID(id)) return null;
    let query = supabaseAdmin
        .from('inventory_count_sessions')
        .select('*')
        .eq('id', id)
        .eq('company_id', companyId);
    if (statuses) query = query.in('status', statuses);
    const { data } = await query.maybeSingle();
    return data || null;
}

/**
 * POST /counts/:id/lines
 * Record (or re-record) a counted quantity. Body: { product_id, counted_qty,
 * scanned_barcode?, note?, actor_label }
 */
router.post('/counts/:id/lines', async (req, res) => {
    try {
        const companyId = req.company.id;
        const session = await loadSession(companyId, req.params.id, ['open']);
        if (!session) return res.status(404).json({ error: 'Count not found, or already closed.' });

        const actor = actorLabel(req);
        if (!actor) return res.status(400).json({ error: 'Enter your name so the count can be attributed.' });

        const productId = req.body?.product_id;
        if (!isValidUUID(productId)) return res.status(400).json({ error: 'A valid product is required.' });

        const counted = Number(req.body?.counted_qty);
        if (!Number.isFinite(counted) || counted < 0 || counted > 1000000) {
            return res.status(400).json({ error: 'Counted quantity must be between 0 and 1,000,000.' });
        }

        const { data: product } = await supabaseAdmin
            .from('products').select('id, sku, name, category')
            .eq('id', productId).eq('company_id', companyId).maybeSingle();
        if (!product) return res.status(404).json({ error: 'Product not found for this account.' });

        if (session.scope_type === 'category' && (product.category || '') !== session.scope_value) {
            return res.status(400).json({ error: `This count covers ${session.scope_value} only.` });
        }

        const { data: level } = await supabaseAdmin
            .from('inventory_levels').select('on_hand')
            .eq('location_id', session.location_id).eq('product_id', productId).maybeSingle();
        const expected = Number(level?.on_hand ?? 0);

        const { data: line, error } = await supabaseAdmin
            .from('inventory_count_lines')
            .upsert({
                session_id: session.id,
                product_id: productId,
                sku: product.sku,
                name: product.name,
                counted_qty: round4(counted),
                expected_qty: expected,
                variance: round4(counted - expected),
                counted_by: actor,
                scanned_barcode: req.body?.scanned_barcode ? canonicalBarcode(req.body.scanned_barcode) : null,
                note: text(req.body?.note, 200) || null,
                updated_at: new Date().toISOString()
            }, { onConflict: 'session_id,product_id' })
            .select()
            .single();
        if (error) throw error;

        await refreshSessionCounters(session.id);

        res.status(201).json({
            line,
            expected_qty: expected,
            variance: round4(counted - expected)
        });
    } catch (err) {
        console.error('Count line error:', err);
        res.status(500).json({ error: 'Failed to record that count.' });
    }
});

async function refreshSessionCounters(sessionId) {
    const { data: lines } = await supabaseAdmin
        .from('inventory_count_lines').select('variance').eq('session_id', sessionId);
    await supabaseAdmin
        .from('inventory_count_sessions')
        .update({
            line_count: (lines || []).length,
            variance_count: (lines || []).filter(l => Number(l.variance) !== 0).length
        })
        .eq('id', sessionId);
}

/** DELETE /counts/:id/lines/:lineId — remove a mis-scanned line. */
router.delete('/counts/:id/lines/:lineId', async (req, res) => {
    try {
        const session = await loadSession(req.company.id, req.params.id, ['open']);
        if (!session) return res.status(404).json({ error: 'Count not found, or already closed.' });

        const { error } = await supabaseAdmin
            .from('inventory_count_lines')
            .delete().eq('id', req.params.lineId).eq('session_id', session.id);
        if (error) throw error;

        await refreshSessionCounters(session.id);
        res.json({ message: 'Line removed.' });
    } catch (err) {
        console.error('Delete count line error:', err);
        res.status(500).json({ error: 'Failed to remove that line.' });
    }
});

/**
 * POST /counts/:id/commit
 * Apply the count. Body: { actor_label, reason? }
 *
 * Writes one `count` movement per genuine variance, computed against on-hand at
 * commit time rather than at count time, so stock that legitimately moved while
 * the count was open is not silently reversed.
 */
router.post('/counts/:id/commit', async (req, res) => {
    try {
        const companyId = req.company.id;
        const session = await loadSession(companyId, req.params.id, ['open']);
        if (!session) return res.status(404).json({ error: 'Count not found, or already closed.' });

        const actor = actorLabel(req);
        if (!actor) return res.status(400).json({ error: 'Enter your name to commit this count.' });

        const { data: lines } = await supabaseAdmin
            .from('inventory_count_lines').select('*').eq('session_id', session.id);
        if (!lines || lines.length === 0) {
            return res.status(400).json({ error: 'Nothing has been counted yet.' });
        }

        const productIds = lines.map(l => l.product_id);
        const currentByProduct = {};
        const { data: levels } = await supabaseAdmin
            .from('inventory_levels').select('product_id, on_hand')
            .eq('location_id', session.location_id).in('product_id', productIds);
        for (const l of levels || []) currentByProduct[l.product_id] = Number(l.on_hand);

        const reason = text(req.body?.reason, 200) || `Cycle count "${session.name}"`;
        const applied = [];
        const unchanged = [];
        const failed = [];

        for (const line of lines) {
            const onHand = currentByProduct[line.product_id] ?? 0;
            const delta = round4(Number(line.counted_qty) - onHand);
            if (delta === 0) { unchanged.push(line.sku || line.product_id); continue; }

            const { data: movement, error } = await supabaseAdmin
                .from('stock_movements')
                .insert({
                    company_id: companyId,
                    location_id: session.location_id,
                    product_id: line.product_id,
                    qty_change: delta,
                    movement_type: 'count',
                    reason: `${reason} — counted ${line.counted_qty}, system had ${onHand}`,
                    source_doc_type: 'count_session',
                    source_doc_id: session.id,
                    scanned_barcode: line.scanned_barcode,
                    actor_type: 'store',
                    actor_label: line.counted_by || actor
                })
                .select('id, qty_change, on_hand_after')
                .single();

            if (error) { failed.push({ sku: line.sku, error: error.message }); continue; }
            applied.push({
                sku: line.sku, name: line.name,
                variance: delta, on_hand: Number(movement.on_hand_after)
            });
        }

        const now = new Date().toISOString();
        await supabaseAdmin
            .from('inventory_count_sessions')
            .update({
                status: 'committed',
                committed_at: now,
                committed_by: actor,
                line_count: lines.length,
                variance_count: applied.length
            })
            .eq('id', session.id)
            .eq('status', 'open');

        res.json({
            message: applied.length
                ? `Count committed — ${applied.length} adjustment${applied.length === 1 ? '' : 's'} posted.`
                : 'Count committed — everything matched.',
            adjusted: applied.length,
            unchanged: unchanged.length,
            failed: failed.length,
            adjustments: applied.slice(0, 100),
            failures: failed
        });
    } catch (err) {
        console.error('Commit count error:', err);
        res.status(500).json({ error: 'Failed to commit that count.' });
    }
});

/** POST /counts/:id/cancel — abandon a session. Body: { actor_label, reason } */
router.post('/counts/:id/cancel', async (req, res) => {
    try {
        const session = await loadSession(req.company.id, req.params.id, ['open']);
        if (!session) return res.status(404).json({ error: 'Count not found, or already closed.' });

        const actor = actorLabel(req);
        if (!actor) return res.status(400).json({ error: 'Enter your name to cancel this count.' });

        const reason = text(req.body?.reason, 200);
        if (!reason) return res.status(400).json({ error: 'A reason is required when cancelling a count.' });

        const { data, error } = await supabaseAdmin
            .from('inventory_count_sessions')
            .update({
                status: 'cancelled',
                cancelled_at: new Date().toISOString(),
                committed_by: actor,
                notes: [session.notes, `Cancelled by ${actor}: ${reason}`].filter(Boolean).join(' | ')
            })
            .eq('id', session.id).eq('status', 'open')
            .select().single();
        if (error) throw error;

        res.json({ message: 'Count cancelled. No stock was changed.', session: data });
    } catch (err) {
        console.error('Cancel count error:', err);
        res.status(500).json({ error: 'Failed to cancel that count.' });
    }
});

// ============================================================
// INTER-LOCATION TRANSFERS
// ============================================================

/**
 * POST /transfers
 * Move stock between two of this company's locations.
 * Body: { from_location_id, to_location_id, product_id, quantity, reason?, actor_label }
 *
 * Two ledger rows have to agree. Postgres has no cross-statement transaction
 * over PostgREST, so the outbound leg is written first and reversed if the
 * inbound leg fails — the stock is never counted in two places at once, and a
 * partial transfer leaves a visible, self-cancelling pair rather than a hole.
 */
/**
 * One product, one direction, both ledger legs. Shared by the single-line
 * endpoint below and the batch endpoint the scan basket posts to — a transfer
 * is the same operation either way, and a shortfall or a reversed leg must be
 * handled identically regardless of which door it came in.
 *
 * `from` and `to` are already-resolved locations (validated once by the
 * caller, not per line, since a scan basket shares one From/To pair).
 *
 * @returns {{ok:true, message, transfer, from_on_hand, to_on_hand}|{ok:false, error}}
 */
async function performOneTransfer({ companyId, settings, from, to, actor, productId, quantity, reason, scannedBarcode }) {
    if (!isValidUUID(productId)) return { ok: false, error: 'A valid product is required.' };

    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1000000) {
        return { ok: false, error: 'Transfer quantity must be greater than zero.' };
    }

    const { data: product } = await supabaseAdmin
        .from('products').select('id, sku, name, category, is_active')
        .eq('id', productId).eq('company_id', companyId).maybeSingle();
    if (!product) return { ok: false, error: 'Product not found for this account.' };
    if (product.is_active === false) return { ok: false, error: 'That product is no longer active.' };

    // The destination's category lock applies to arriving stock too.
    if (to.restrict_to_category && (product.category || '') !== to.restrict_to_category) {
        return { ok: false, error: `${to.name} only stocks ${to.restrict_to_category} items.` };
    }

    const { data: fromLevel } = await supabaseAdmin
        .from('inventory_levels').select('on_hand')
        .eq('location_id', from.id).eq('product_id', productId).maybeSingle();
    const available = Number(fromLevel?.on_hand ?? 0);

    if (!settings.allow_negative && available < qty) {
        return { ok: false, error: `Only ${available} on hand for ${product.sku || product.name} at ${from.name}.`, on_hand: available };
    }

    const reasonText = reason || `Transfer to ${to.name}`;
    const delta = round4(qty);
    const barcode = scannedBarcode ? canonicalBarcode(scannedBarcode) : null;

    const { data: outMove, error: outErr } = await supabaseAdmin
        .from('stock_movements')
        .insert({
            company_id: companyId, location_id: from.id, product_id: productId,
            qty_change: -delta, movement_type: 'transfer_out',
            reason: `${reasonText} (to ${to.name})`,
            source_doc_type: 'transfer',
            scanned_barcode: barcode,
            actor_type: 'store', actor_label: actor
        })
        .select('id, on_hand_after').single();
    if (outErr) return { ok: false, error: outErr.message };

    const { data: inMove, error: inErr } = await supabaseAdmin
        .from('stock_movements')
        .insert({
            company_id: companyId, location_id: to.id, product_id: productId,
            qty_change: delta, movement_type: 'transfer_in',
            reason: `${reasonText} (from ${from.name})`,
            source_doc_type: 'transfer',
            scanned_barcode: barcode,
            actor_type: 'store', actor_label: actor
        })
        .select('id, on_hand_after').single();

    if (inErr) {
        // Reverse the outbound leg so the stock reappears where it started.
        // The ledger is append-only, so this is a compensating movement, not
        // a delete — the failed attempt stays visible.
        await supabaseAdmin.from('stock_movements').insert({
            company_id: companyId, location_id: from.id, product_id: productId,
            qty_change: delta, movement_type: 'adjust',
            reason: `Reversing failed transfer to ${to.name}`,
            source_doc_type: 'transfer_reversal', source_doc_id: outMove.id,
            actor_type: 'system', actor_label: 'refinishAI Inventory'
        });
        console.error('Transfer inbound leg failed, reversed:', inErr.message);
        return { ok: false, error: 'The transfer could not be completed and was reversed.' };
    }

    const { data: transfer } = await supabaseAdmin
        .from('inventory_transfers')
        .insert({
            company_id: companyId,
            from_location_id: from.id,
            to_location_id: to.id,
            product_id: productId,
            quantity: delta,
            reason: reasonText,
            actor_label: actor,
            out_movement_id: outMove.id,
            in_movement_id: inMove.id
        })
        .select().single();

    return {
        ok: true,
        message: `${delta} × ${product.sku || product.name} moved from ${from.name} to ${to.name}.`,
        transfer,
        product_id: product.id,
        sku: product.sku,
        from_on_hand: Number(outMove.on_hand_after),
        to_on_hand: Number(inMove.on_hand_after)
    };
}

router.post('/transfers', async (req, res) => {
    try {
        const companyId = req.company.id;
        const settings = req.inventorySettings;

        const from = await resolveLocation(companyId, req.body?.from_location_id);
        const to   = await resolveLocation(companyId, req.body?.to_location_id);
        if (!from) return res.status(400).json({ error: 'Select a valid source location.' });
        if (!to)   return res.status(400).json({ error: 'Select a valid destination location.' });
        if (from.id === to.id) return res.status(400).json({ error: 'Source and destination must be different.' });

        const actor = actorLabel(req);
        if (!actor) return res.status(400).json({ error: 'Enter your name to record a transfer.' });

        const outcome = await performOneTransfer({
            companyId, settings, from, to, actor,
            productId: req.body?.product_id,
            quantity: req.body?.quantity,
            reason: text(req.body?.reason, 200)
        });

        if (!outcome.ok) {
            const status = outcome.on_hand !== undefined ? 409 : (outcome.error.includes('not found') ? 404 : 400);
            return res.status(status).json(outcome);
        }
        res.status(201).json(outcome);
    } catch (err) {
        console.error('Transfer error:', err);
        res.status(500).json({ error: 'Failed to record that transfer.' });
    }
});

/**
 * POST /transfers/bulk
 * Body: { from_location_id, to_location_id, actor_label, reason?, transfers: [{ product_id, quantity, scanned_barcode? }] }
 *
 * The scan-basket equivalent of the single-line endpoint above: one From/To
 * pair, validated once, then every staged line posted as its own two-legged
 * transfer. Mirrors /movements/bulk's shape — per-line ok/error — so a line
 * that fails (usually a shortfall) stays on the caller's list with its reason
 * while the rest go through.
 */
router.post('/transfers/bulk', async (req, res) => {
    try {
        const companyId = req.company.id;
        const settings = req.inventorySettings;

        const from = await resolveLocation(companyId, req.body?.from_location_id);
        const to   = await resolveLocation(companyId, req.body?.to_location_id);
        if (!from) return res.status(400).json({ error: 'Select a valid source location.' });
        if (!to)   return res.status(400).json({ error: 'Select a valid destination location.' });
        if (from.id === to.id) return res.status(400).json({ error: 'Source and destination must be different.' });

        const actor = actorLabel(req);
        if (!actor) return res.status(400).json({ error: 'Enter your name to record a transfer.' });

        const reason = text(req.body?.reason, 200);
        const lines = Array.isArray(req.body?.transfers) ? req.body.transfers : [];
        if (lines.length === 0) return res.status(400).json({ error: 'No transfers supplied.' });
        if (lines.length > 500) return res.status(400).json({ error: 'Maximum 500 transfers per batch.' });

        const results = [];
        for (const [idx, line] of lines.entries()) {
            try {
                const outcome = await performOneTransfer({
                    companyId, settings, from, to, actor,
                    productId: line?.product_id,
                    quantity: line?.quantity,
                    reason,
                    scannedBarcode: line?.scanned_barcode
                });
                results.push({ index: idx, ...outcome });
            } catch (e) {
                results.push({ index: idx, ok: false, error: e.message || 'Failed to record that transfer.' });
            }
        }

        const applied = results.filter(r => r.ok).length;
        res.status(applied ? 201 : 400).json({
            message: `${applied} of ${lines.length} transfer(s) recorded.`,
            applied,
            failed: results.length - applied,
            results
        });
    } catch (err) {
        console.error('Bulk transfer error:', err);
        res.status(500).json({ error: 'Failed to record that batch.' });
    }
});

/** GET /transfers?location_id=&limit= — transfers touching a location. */
router.get('/transfers', async (req, res) => {
    try {
        const companyId = req.company.id;
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));

        const { data, error } = await supabaseAdmin
            .from('inventory_transfers')
            .select('*, products(sku, name, brand)')
            .eq('company_id', companyId)
            .order('created_at', { ascending: false })
            .limit(limit);
        if (error) throw error;

        let rows = data || [];
        if (req.query.location_id && isValidUUID(req.query.location_id)) {
            const id = req.query.location_id;
            rows = rows.filter(t => t.from_location_id === id || t.to_location_id === id);
        }

        // Resolve names once rather than embedding the same table twice.
        const locIds = [...new Set(rows.flatMap(t => [t.from_location_id, t.to_location_id]))];
        const names = {};
        if (locIds.length) {
            const { data: locs } = await supabaseAdmin
                .from('company_locations').select('id, name').in('id', locIds);
            for (const l of locs || []) names[l.id] = l.name;
        }

        res.json({
            transfers: rows.map(t => ({
                ...t,
                from_location_name: names[t.from_location_id] || null,
                to_location_name: names[t.to_location_id] || null
            }))
        });
    } catch (err) {
        console.error('List transfers error:', err);
        res.status(500).json({ error: 'Failed to load transfers.' });
    }
});

module.exports = router;
