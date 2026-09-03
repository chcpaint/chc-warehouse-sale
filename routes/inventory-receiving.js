/**
 * routes/inventory-receiving.js
 *
 * refinishAI Inventory — receiving tied to a CHC order, mounted from
 * routes/inventory-store.js at /api/store/:slug/inventory/receiving
 *
 * requireCompanyAuth and requireInventoryEnabled are already applied by the
 * parent before this file is reached. resolveLocation, postOneMovement,
 * text and actorLabel are handed down on the request by the mount point in
 * inventory-store.js, the same way inventory-kits.js receives them, so a
 * receipt is written through the exact validation /movements/bulk uses
 * rather than a second copy of it.
 *
 * A plain 'receive' scan (the Scan tab) has no memory of why stock arrived.
 * This is the same physical action -- scan a box, stage it, post the batch --
 * aimed at a specific order instead: pick what's arriving, see what's still
 * owed on it, scan against it, and every line lands in order_receipts as well
 * as the ordinary stock ledger, so "did this order actually show up" is a
 * question the console can answer later.
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { isValidUUID } = require('../utils/sanitize');

const router = express.Router({ mergeParams: true });

// Orders in these states are things a truck could plausibly be delivering.
// 'pending' is excluded -- CHC has not even confirmed it yet, so there is
// nothing to receive against. 'cancelled' and 'closed' are excluded below,
// per-order, with a clearer message than just leaving them off a list.
const RECEIVABLE_STATUSES = ['confirmed', 'processing', 'shipped', 'delivered'];

/** Every receipt logged against an order, summed by product_id, plus the unexpected ones on their own. */
async function receivedSoFar(orderId) {
    const { data } = await supabaseAdmin
        .from('order_receipts')
        .select('product_id, quantity_received, unexpected_item')
        .eq('order_id', orderId);

    const byProduct = new Map();
    const unexpected = [];
    for (const r of data || []) {
        if (r.unexpected_item) { unexpected.push(r); continue; }
        if (!r.product_id) continue;
        byProduct.set(r.product_id, (byProduct.get(r.product_id) || 0) + Number(r.quantity_received));
    }
    return { byProduct, unexpected };
}

function orderSummary(order, byProduct) {
    const items = Array.isArray(order.items) ? order.items : [];
    let orderedTotal = 0, receivedTotal = 0;
    for (const line of items) {
        orderedTotal += Number(line.quantity) || 0;
        receivedTotal += Math.min(byProduct.get(line.product_id) || 0, Number(line.quantity) || 0);
    }
    return {
        id: order.id,
        order_number: order.order_number || null,
        po_number: order.po_number || null,
        status: order.status,
        location_id: order.location_id,
        location: order.location,
        created_at: order.created_at,
        line_count: items.length,
        ordered_total: orderedTotal,
        received_total: receivedTotal,
        fully_received: items.length > 0 && receivedTotal >= orderedTotal
    };
}

/**
 * GET /orders?location_id=
 * Orders this company could plausibly be receiving right now, newest first,
 * with what has arrived against each one so far. location_id narrows to
 * orders placed for that location; omit it to see everything receivable.
 */
router.get('/orders', async (req, res) => {
    try {
        const companyId = req.company.id;

        let query = supabaseAdmin
            .from('orders')
            .select('id, order_number, po_number, status, location_id, location, items, created_at')
            .eq('company_id', companyId)
            .in('status', RECEIVABLE_STATUSES)
            .order('created_at', { ascending: false })
            .limit(200);

        if (req.query.location_id && isValidUUID(req.query.location_id)) {
            query = query.eq('location_id', req.query.location_id);
        }

        const { data: orders, error } = await query;
        if (error) throw error;

        const rows = orders || [];
        if (rows.length === 0) return res.json({ orders: [] });

        const { data: receiptRows } = await supabaseAdmin
            .from('order_receipts')
            .select('order_id, product_id, quantity_received, unexpected_item')
            .in('order_id', rows.map(o => o.id));

        const byOrder = new Map();
        for (const r of receiptRows || []) {
            if (r.unexpected_item || !r.product_id) continue;
            if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, new Map());
            const m = byOrder.get(r.order_id);
            m.set(r.product_id, (m.get(r.product_id) || 0) + Number(r.quantity_received));
        }

        const summaries = rows.map(o => orderSummary(o, byOrder.get(o.id) || new Map()));
        // Whatever still needs attention first; a fully-received order is history, not a task.
        summaries.sort((a, b) => (a.fully_received === b.fully_received ? 0 : a.fully_received ? 1 : -1));

        res.json({ orders: summaries });
    } catch (err) {
        console.error('Receivable orders error:', err);
        res.status(500).json({ error: 'Failed to load orders.' });
    }
});

/**
 * GET /orders/:orderId
 * One order's lines, each with what's ordered, what has arrived so far, and
 * what is still owed -- plus anything scanned in against this order that was
 * never on it at all.
 */
router.get('/orders/:orderId', async (req, res) => {
    try {
        const companyId = req.company.id;
        const orderId = req.params.orderId;
        if (!isValidUUID(orderId)) return res.status(400).json({ error: 'Invalid order id.' });

        const { data: order } = await supabaseAdmin
            .from('orders')
            .select('id, order_number, po_number, status, location_id, location, items, created_at')
            .eq('id', orderId).eq('company_id', companyId).maybeSingle();
        if (!order) return res.status(404).json({ error: 'Order not found.' });

        const { byProduct, unexpected } = await receivedSoFar(orderId);
        const items = Array.isArray(order.items) ? order.items : [];

        const lines = items.map(line => {
            const ordered = Number(line.quantity) || 0;
            const received = byProduct.get(line.product_id) || 0;
            return {
                product_id: line.product_id,
                sku: line.sku,
                name: line.name,
                quantity_ordered: ordered,
                quantity_received: received,
                remaining: Math.max(0, ordered - received),
                over_received: received > ordered
            };
        });

        res.json({
            order: orderSummary(order, byProduct),
            receivable: RECEIVABLE_STATUSES.includes(order.status),
            lines,
            unexpected: unexpected.map(u => ({
                product_id: u.product_id, quantity_received: Number(u.quantity_received)
            }))
        });
    } catch (err) {
        console.error('Order receiving detail error:', err);
        res.status(500).json({ error: 'Failed to load that order.' });
    }
});

/**
 * POST /orders/:orderId/lines
 * Body: { location_id, actor_label, receipts: [{ product_id, quantity, scanned_barcode? }] }
 *
 * The scan basket's Post, aimed at this order. Each line writes an ordinary
 * stock_movements row through the same path /movements/bulk uses (so category
 * locks, the negative-stock guard and auto-draft all still apply) plus one
 * order_receipts row remembering which order it came off. A line for a
 * product the order never had is not refused -- it is recorded as
 * unexpected_item, which is what actually happened. Over-receiving a line
 * that IS on the order is flagged in the response, not blocked either: it is
 * usually a correction or a supplier overship, not an error to lose the scan
 * over.
 */
router.post('/orders/:orderId/lines', async (req, res) => {
    try {
        const companyId = req.company.id;
        const orderId = req.params.orderId;
        if (!isValidUUID(orderId)) return res.status(400).json({ error: 'Invalid order id.' });

        const { data: order } = await supabaseAdmin
            .from('orders')
            .select('id, status, items')
            .eq('id', orderId).eq('company_id', companyId).maybeSingle();
        if (!order) return res.status(404).json({ error: 'Order not found.' });
        if (order.status === 'cancelled') return res.status(400).json({ error: 'This order was cancelled -- nothing to receive.' });
        if (order.status === 'closed') return res.status(400).json({ error: 'This order is already closed.' });

        const location = await req.resolveLocation(companyId, req.body?.location_id);
        if (!location) return res.status(400).json({ error: 'Select a valid location first.' });

        const actor = req.actorLabel();
        if (!actor) return res.status(400).json({ error: 'Enter your name so the receipt can be attributed.' });

        const lines = Array.isArray(req.body?.receipts) ? req.body.receipts : [];
        if (lines.length === 0) return res.status(400).json({ error: 'No lines supplied.' });
        if (lines.length > 500) return res.status(400).json({ error: 'Maximum 500 lines per batch.' });

        const itemsById = new Map((order.items || []).map(l => [l.product_id, l]));
        const { byProduct: receivedBefore } = await receivedSoFar(orderId);

        const results = [];
        for (const [idx, line] of lines.entries()) {
            try {
                const productId = line?.product_id;
                if (!isValidUUID(productId)) { results.push({ index: idx, ok: false, error: 'Invalid product' }); continue; }

                const quantity = Number(line?.quantity);
                if (!Number.isFinite(quantity) || quantity <= 0) {
                    results.push({ index: idx, ok: false, error: 'Quantity must be greater than zero' }); continue;
                }

                const orderLine = itemsById.get(productId);
                const outcome = await req.postOneMovement({
                    companyId, location, actor, settings: req.inventorySettings,
                    line: { product_id: productId, movement_type: 'receive', quantity, scanned_barcode: line.scanned_barcode,
                             reason: `Received against order ${order.order_number || orderId.slice(0, 8)}` },
                    sourceDocType: 'order_receive',
                    sourceDocId: orderId
                });

                if (!outcome.ok) { results.push({ index: idx, ...outcome }); continue; }

                const alreadyReceived = receivedBefore.get(productId) || 0;
                const orderedQty = orderLine ? Number(orderLine.quantity) || 0 : null;

                await supabaseAdmin.from('order_receipts').insert({
                    company_id: companyId,
                    order_id: orderId,
                    location_id: location.id,
                    product_id: productId,
                    sku: outcome.sku || orderLine?.sku || null,
                    name: orderLine?.name || null,
                    quantity_received: quantity,
                    quantity_ordered: orderedQty,
                    unexpected_item: !orderLine,
                    scanned_barcode: line.scanned_barcode || null,
                    movement_id: outcome.movement_id,
                    actor_label: actor
                });

                // So a batch of several lines for the same product accumulates
                // correctly for the over-received flag within one request.
                receivedBefore.set(productId, alreadyReceived + quantity);

                results.push({
                    index: idx, ok: true,
                    product_id: productId, sku: outcome.sku,
                    on_hand: outcome.on_hand,
                    unexpected_item: !orderLine,
                    quantity_ordered: orderedQty,
                    quantity_received_total: orderedQty !== null ? alreadyReceived + quantity : null,
                    over_received: orderedQty !== null && (alreadyReceived + quantity) > orderedQty
                });
            } catch (e) {
                results.push({ index: idx, ok: false, error: e.message || 'Failed to record that receipt.' });
            }
        }

        const applied = results.filter(r => r.ok).length;
        res.status(applied ? 201 : 400).json({
            message: `${applied} of ${lines.length} line(s) received.`,
            applied,
            failed: results.length - applied,
            results
        });
    } catch (err) {
        console.error('Order receiving error:', err);
        res.status(500).json({ error: 'Failed to record that batch.' });
    }
});

module.exports = router;
