/**
 * utils/inventory-corrections.js -- putting right a finished count or a posted
 * delivery (migration 069).
 *
 * Staff make mistakes: a shelf counted as 12 that holds 10, six cans received
 * against an order when four came off the truck. Once a count is committed or
 * a delivery is posted, the shop floor cannot change it. A manager or admin in
 * the console can, through the two functions here.
 *
 * Neither function edits or deletes anything that was posted. Each one:
 *   1. works out the difference between what was recorded and the right number,
 *   2. posts ONE 'adjust' movement for that difference (the ledger stays
 *      append-only, and on hand moves by exactly the difference),
 *   3. records the correction in inventory_corrections (before, after, why, who),
 *   4. brings the record itself into line: the count line now says the right
 *      number; a delivery gets an order_receipts row for the difference, so
 *      "received so far" on the order is right.
 *
 * Who may do this is decided by canCorrect(); scope (which customers and
 * orders) is decided by the route.
 */
const { supabaseAdmin } = require('./supabase');
const { round4, inventorySettings } = require('./inventory');

const NOT_INSTALLED = /inventory_corrections|order_receipts_exception_chk|relation .* does not exist|schema cache/i;
const SETUP_MESSAGE = 'Corrections are not set up yet. Run migrations/069_inventory_corrections.sql in Supabase first.';
const MAX_QTY = 1000000;

/** Managers and admins: super admin, company admin, order manager, or a branch manager on the order desk. */
function canCorrect(admin) {
    if (!admin) return false;
    if (['super_admin', 'admin', 'order_manager'].includes(admin.role)) return true;
    return admin.role === 'order_desk' && admin.is_branch_manager === true;
}

class CorrectionError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new CorrectionError(status, message); };

function cleanReason(v) {
    return String(v === undefined || v === null ? '' : v).replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);
}

function checkInputs(qty, reason) {
    const n = Number(qty);
    if (qty === '' || qty === null || qty === undefined || !Number.isFinite(n) || n < 0 || n > MAX_QTY) {
        fail(400, 'Enter the right quantity: 0 or more.');
    }
    const why = cleanReason(reason);
    if (why.length < 3) fail(400, 'Say why it is being corrected (for example "miscounted, recounted the shelf").');
    return { qty: round4(n), why };
}

async function onHandAt(locationId, productId) {
    const { data } = await supabaseAdmin.from('inventory_levels').select('on_hand')
        .eq('location_id', locationId).eq('product_id', productId).maybeSingle();
    return Number(data?.on_hand ?? 0);
}

async function guardNegative(companyId, locationId, productId, delta, name) {
    if (delta >= 0) return;
    const { data: co } = await supabaseAdmin.from('companies').select('settings').eq('id', companyId).maybeSingle();
    if (inventorySettings(co?.settings).allow_negative) return;
    const onHand = await onHandAt(locationId, productId);
    if (onHand + delta < 0) {
        fail(409, `Only ${onHand} of ${name || 'that item'} on hand now, so taking ${-delta} off would go below zero. Count the shelf again instead.`);
    }
}

function actorFields(actor) {
    return {
        actor_type: actor.type === 'store' ? 'store' : 'admin',
        actor_label: String(actor.label || '').slice(0, 120) || null
    };
}

/** Insert the correction record first: if migration 069 is missing, nothing else is written. */
async function recordCorrection(row) {
    const { data, error } = await supabaseAdmin.from('inventory_corrections').insert(row).select('*').single();
    if (error) {
        if (NOT_INSTALLED.test(error.message || '')) fail(503, SETUP_MESSAGE);
        throw error;
    }
    return data;
}

async function postAdjust({ companyId, locationId, productId, delta, reason, docType, docId, actor }) {
    const { data, error } = await supabaseAdmin.from('stock_movements').insert({
        company_id: companyId,
        location_id: locationId,
        product_id: productId,
        qty_change: delta,
        movement_type: 'adjust',
        reason,
        source_doc_type: docType,
        source_doc_id: docId,
        ...actorFields(actor),
        created_by: actor.adminId || null
    }).select('id, on_hand_after').single();
    if (error) throw error;
    return data;
}

async function undo(table, id) {
    if (!id) return;
    try { await supabaseAdmin.from(table).delete().eq('id', id); } catch (e) { /* best effort */ }
}

// ------------------------------------------------------------------
// COUNTS
// ------------------------------------------------------------------

/**
 * Change the counted quantity on one line of a count.
 *
 * An open count is simply changed (nothing has been posted yet). A committed
 * count gets an adjust movement for the difference and a correction record.
 *
 * @returns {Promise<{mode:'open'|'committed', line, correction?, movement?, qty_change}>}
 */
async function correctCountLine({ companyId, sessionId, lineId, countedQty, reason, actor }) {
    const { qty, why } = checkInputs(countedQty, reason);

    const { data: session } = await supabaseAdmin.from('inventory_count_sessions').select('*')
        .eq('id', sessionId).eq('company_id', companyId).maybeSingle();
    if (!session) fail(404, 'That count was not found.');
    if (session.status === 'cancelled') fail(409, 'That count was cancelled, so nothing from it was posted.');

    const { data: line } = await supabaseAdmin.from('inventory_count_lines').select('*')
        .eq('id', lineId).eq('session_id', session.id).maybeSingle();
    if (!line) fail(404, 'That line is not on this count.');

    const before = round4(Number(line.counted_qty));
    const delta = round4(qty - before);
    if (delta === 0) fail(400, `The count already says ${before}.`);

    const expected = line.expected_qty === null || line.expected_qty === undefined ? null : Number(line.expected_qty);
    const linePatch = {
        counted_qty: qty,
        ...(expected !== null ? { variance: round4(qty - expected) } : {}),
        note: `${line.note ? line.note + ' · ' : ''}Changed from ${before} to ${qty} by ${actor.label || 'an admin'}: ${why}`.slice(0, 500),
        updated_at: new Date().toISOString()
    };

    if (session.status === 'open') {
        const { data: updated, error } = await supabaseAdmin.from('inventory_count_lines')
            .update(linePatch).eq('id', line.id).select('*').single();
        if (error) throw error;
        return { mode: 'open', line: updated, qty_change: 0 };
    }

    await guardNegative(companyId, session.location_id, line.product_id, delta, line.name || line.sku);

    const correction = await recordCorrection({
        company_id: companyId, location_id: session.location_id, kind: 'count',
        count_session_id: session.id, count_line_id: line.id, product_id: line.product_id,
        sku: line.sku || null, name: line.name || null,
        old_qty: before, new_qty: qty, qty_change: delta, reason: why,
        ...actorFields(actor), admin_id: actor.adminId || null
    });

    let movement;
    try {
        movement = await postAdjust({
            companyId, locationId: session.location_id, productId: line.product_id, delta,
            reason: `Count correction: "${session.name || 'count'}" ${line.sku || ''} counted ${before}, should have been ${qty}. ${why}`.slice(0, 500),
            docType: 'count_correction', docId: session.id, actor
        });
    } catch (err) {
        await undo('inventory_corrections', correction.id);
        throw err;
    }

    await supabaseAdmin.from('inventory_corrections').update({ movement_id: movement.id }).eq('id', correction.id);
    const { data: updated } = await supabaseAdmin.from('inventory_count_lines')
        .update(linePatch).eq('id', line.id).select('*').single();

    return {
        mode: 'committed',
        line: updated || { ...line, ...linePatch },
        correction: { ...correction, movement_id: movement.id },
        movement,
        qty_change: delta,
        on_hand: Number(movement.on_hand_after)
    };
}

// ------------------------------------------------------------------
// DELIVERIES (order receiving)
// ------------------------------------------------------------------

/**
 * What a shop has received against an order: one entry per item that was
 * ordered or received, plus the corrections made so far.
 */
async function receivingForOrder(order) {
    const items = Array.isArray(order.items) ? order.items : [];
    const { data: receipts } = await supabaseAdmin.from('order_receipts')
        .select('id, product_id, sku, name, quantity_received, quantity_ordered, unexpected_item, exception_type, exception_note, location_id, actor_label, actor_type, created_at')
        .eq('order_id', order.id);

    const byProduct = new Map();
    const entry = (productId, sku, name, ordered) => {
        if (!byProduct.has(productId)) {
            byProduct.set(productId, { product_id: productId, sku: sku || '', name: name || '', quantity_ordered: ordered,
                quantity_received: 0, damaged: 0, on_order: ordered !== null, last_location_id: null, _last: '' });
        }
        return byProduct.get(productId);
    };
    for (const l of items) if (l.product_id) entry(l.product_id, l.sku, l.name, Number(l.quantity) || 0);
    for (const r of receipts || []) {
        if (!r.product_id) continue;
        const e = entry(r.product_id, r.sku, r.name, null);
        if (r.exception_type === 'damaged') e.damaged = round4(e.damaged + Number(r.quantity_received));
        else e.quantity_received = round4(e.quantity_received + Number(r.quantity_received));
        if (String(r.created_at || '') >= e._last) { e._last = String(r.created_at || ''); e.last_location_id = r.location_id; }
    }
    const lines = [...byProduct.values()].map(({ _last, ...rest }) => rest);

    let corrections = [];
    const { data: rows, error } = await supabaseAdmin.from('inventory_corrections')
        .select('id, product_id, sku, name, old_qty, new_qty, qty_change, reason, actor_label, created_at')
        .eq('order_id', order.id).eq('kind', 'receipt');
    if (!error) corrections = (rows || []).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

    return {
        lines,
        receipt_count: (receipts || []).length,
        corrections,
        installed: !error || !NOT_INSTALLED.test(error.message || '')
    };
}

/**
 * Set how many of one item were really received against an order.
 * Posts an adjust movement for the difference at the location it was received
 * into, and an order_receipts row for the difference.
 */
async function correctReceipt({ companyId, orderId, productId, receivedQty, reason, actor }) {
    const { qty, why } = checkInputs(receivedQty, reason);

    const { data: order } = await supabaseAdmin.from('orders')
        .select('id, company_id, order_number, items, location_id, status')
        .eq('id', orderId).eq('company_id', companyId).maybeSingle();
    if (!order) fail(404, 'That order was not found.');

    const { lines } = await receivingForOrder(order);
    const line = lines.find(l => l.product_id === productId);
    if (!line) fail(400, 'That item is not on this order and nothing of it was received against it.');

    const before = line.quantity_received;
    const delta = round4(qty - before);
    if (delta === 0) fail(400, `The order already shows ${before} received.`);

    const locationId = line.last_location_id || order.location_id;
    if (!locationId) fail(400, 'This order has no location to correct stock at.');
    const { data: location } = await supabaseAdmin.from('company_locations').select('id, name')
        .eq('id', locationId).eq('company_id', companyId).maybeSingle();
    if (!location) fail(400, 'The location this order was received into no longer exists.');

    const { data: product } = await supabaseAdmin.from('products').select('id, sku, name')
        .eq('id', productId).eq('company_id', companyId).maybeSingle();
    if (!product) fail(400, 'That item is no longer in this customer’s catalogue, so its stock cannot be changed.');

    await guardNegative(companyId, location.id, productId, delta, product.name);

    const correction = await recordCorrection({
        company_id: companyId, location_id: location.id, kind: 'receipt', order_id: order.id,
        product_id: productId, sku: product.sku || line.sku || null, name: product.name || line.name || null,
        old_qty: before, new_qty: qty, qty_change: delta, reason: why,
        ...actorFields(actor), admin_id: actor.adminId || null
    });

    const { data: receipt, error: rErr } = await supabaseAdmin.from('order_receipts').insert({
        company_id: companyId, order_id: order.id, location_id: location.id, product_id: productId,
        sku: product.sku || line.sku || null, name: product.name || line.name || null,
        quantity_received: delta,
        quantity_ordered: line.on_order ? line.quantity_ordered : null,
        unexpected_item: !line.on_order,
        exception_type: 'correction',
        exception_note: `Changed from ${before} to ${qty}: ${why}`.slice(0, 300),
        movement_id: null,
        ...actorFields(actor)
    }).select('id').single();
    if (rErr) {
        await undo('inventory_corrections', correction.id);
        if (NOT_INSTALLED.test(rErr.message || '') || /exception_chk|check constraint/i.test(rErr.message || '')) fail(503, SETUP_MESSAGE);
        throw rErr;
    }

    let movement;
    try {
        movement = await postAdjust({
            companyId, locationId: location.id, productId, delta,
            reason: `Delivery correction: order ${order.order_number || order.id.slice(0, 8)} ${product.sku || ''} received ${before}, really ${qty}. ${why}`.slice(0, 500),
            docType: 'receipt_correction', docId: order.id, actor
        });
    } catch (err) {
        await undo('order_receipts', receipt.id);
        await undo('inventory_corrections', correction.id);
        throw err;
    }

    await supabaseAdmin.from('order_receipts').update({ movement_id: movement.id }).eq('id', receipt.id);
    await supabaseAdmin.from('inventory_corrections').update({ movement_id: movement.id }).eq('id', correction.id);

    return {
        correction: { ...correction, movement_id: movement.id },
        movement,
        qty_change: delta,
        on_hand: Number(movement.on_hand_after),
        location: location.name
    };
}

module.exports = {
    canCorrect, correctCountLine, correctReceipt, receivingForOrder,
    CorrectionError, NOT_INSTALLED, SETUP_MESSAGE
};
