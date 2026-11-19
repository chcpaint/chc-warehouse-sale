/**
 * routes/stock-corrections-admin.js -- a manager or admin putting right a
 * count or a delivery that staff got wrong (migration 069).
 *
 * Mounted from routes/admin.js at /api/admin/companies/:companyId/stock-corrections.
 * Used from the Orders screen of the console, so it is open to the order
 * roles as well as full admins (see ORDER_DESK_ALLOW in middleware/auth.js):
 *
 *   GET  /counts                         ?status=committed|open|all&location_id=
 *   GET  /counts/:sessionId              the count's lines and corrections so far
 *   POST /counts/:sessionId/lines/:lineId  { counted_qty, reason }
 *   GET  /orders/:orderId                what the shop received against the order
 *   POST /orders/:orderId                { product_id, received_qty, reason }
 *
 * Who sees what: the same scope as the Orders screen (an order-desk account
 * only the locations its branches serve; a company admin only its own company;
 * another distributor's customer is "not found").
 *
 * Who may correct: canCorrect() -- super admin, company admin, order manager,
 * or an order-desk account marked as a branch manager. Everyone else in scope
 * can look but not change.
 */
const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { isValidUUID } = require('../utils/sanitize');
const { companyInScope, orderInScope, staffLocationIds } = require('../utils/order-scope');
const { round4 } = require('../utils/inventory');
const {
    canCorrect, correctCountLine, correctReceipt, receivingForOrder, CorrectionError, NOT_INSTALLED
} = require('../utils/inventory-corrections');

const router = express.Router({ mergeParams: true });

const NOT_ALLOWED = 'Only a manager or admin can correct a finished count or a delivery.';

async function logAction(req, action, entityType, entityId, details) {
    try {
        await supabaseAdmin.from('audit_log').insert({
            admin_id: req.admin.id, action, entity_type: entityType, entity_id: entityId, details, ip_address: req.ip
        });
    } catch (err) { console.error('Audit log write failed:', err); }
}

function actorOf(req) {
    return { type: 'admin', label: req.admin.name || req.admin.email || 'Admin', adminId: req.admin.id };
}

function sendError(res, err, fallback) {
    if (err instanceof CorrectionError) return res.status(err.status).json({ error: err.message });
    console.error(fallback, err);
    return res.status(500).json({ error: fallback });
}

/** The company has to be one this account can see. */
router.use(async (req, res, next) => {
    try {
        if (!req.admin) return res.status(403).json({ error: 'Admin authentication required.' });
        const companyId = req.params.companyId;
        if (!isValidUUID(companyId)) return res.status(404).json({ error: 'Customer not found.' });
        if (!(await companyInScope(req, companyId))) return res.status(404).json({ error: 'Customer not found.' });
        next();
    } catch (err) { sendError(res, err, 'Could not check access.'); }
});

/** Locations an order-desk account may see (null = no narrowing). */
async function locationFence(req) {
    return req.admin.role === 'order_desk' ? staffLocationIds(req.admin) : null;
}

async function loadSession(req) {
    const id = req.params.sessionId;
    if (!isValidUUID(id)) return null;
    const { data } = await supabaseAdmin.from('inventory_count_sessions').select('*')
        .eq('id', id).eq('company_id', req.params.companyId).maybeSingle();
    if (!data) return null;
    const fence = await locationFence(req);
    if (fence && !fence.includes(data.location_id)) return null;
    return data;
}

// ------------------------------------------------------------------
// COUNTS
// ------------------------------------------------------------------
router.get('/counts', async (req, res) => {
    try {
        const companyId = req.params.companyId;
        const status = ['committed', 'open'].includes(req.query.status) ? req.query.status : 'all';
        let q = supabaseAdmin.from('inventory_count_sessions')
            .select('id, location_id, name, status, opened_by, committed_by, line_count, variance_count, created_at, committed_at')
            .eq('company_id', companyId);
        q = status === 'all' ? q.in('status', ['open', 'committed']) : q.eq('status', status);
        if (req.query.location_id && isValidUUID(req.query.location_id)) q = q.eq('location_id', req.query.location_id);
        const fence = await locationFence(req);
        if (fence) q = q.in('location_id', fence.length ? fence : ['00000000-0000-0000-0000-000000000000']);
        const { data, error } = await q.order('created_at', { ascending: false }).limit(60);
        if (error) throw error;
        const sessions = (data || []).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

        const locIds = [...new Set(sessions.map(s => s.location_id))];
        const { data: locs } = locIds.length
            ? await supabaseAdmin.from('company_locations').select('id, name').in('id', locIds)
            : { data: [] };
        const locName = new Map((locs || []).map(l => [l.id, l.name]));

        res.json({
            can_correct: canCorrect(req.admin),
            counts: sessions.map(s => ({ ...s, location_name: locName.get(s.location_id) || '' }))
        });
    } catch (err) { sendError(res, err, 'Could not load counts.'); }
});

router.get('/counts/:sessionId', async (req, res) => {
    try {
        const session = await loadSession(req);
        if (!session) return res.status(404).json({ error: 'That count was not found.' });

        const { data: lines } = await supabaseAdmin.from('inventory_count_lines').select('*').eq('session_id', session.id);
        const ids = (lines || []).map(l => l.product_id);
        const onHand = {};
        if (ids.length) {
            const { data: levels } = await supabaseAdmin.from('inventory_levels').select('product_id, on_hand')
                .eq('location_id', session.location_id).in('product_id', ids);
            for (const l of levels || []) onHand[l.product_id] = Number(l.on_hand);
        }
        let corrections = [];
        let installed = true;
        const { data: cRows, error: cErr } = await supabaseAdmin.from('inventory_corrections')
            .select('id, count_line_id, sku, name, old_qty, new_qty, qty_change, reason, actor_label, created_at')
            .eq('count_session_id', session.id);
        if (cErr) installed = !NOT_INSTALLED.test(cErr.message || '');
        else corrections = (cRows || []).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

        const { data: loc } = await supabaseAdmin.from('company_locations').select('name').eq('id', session.location_id).maybeSingle();

        res.json({
            can_correct: canCorrect(req.admin),
            installed,
            session: { ...session, location_name: loc?.name || '' },
            lines: (lines || [])
                .map(l => ({
                    id: l.id, product_id: l.product_id, sku: l.sku, name: l.name,
                    counted_qty: Number(l.counted_qty),
                    expected_qty: l.expected_qty === null ? null : Number(l.expected_qty),
                    on_hand_now: onHand[l.product_id] ?? null,
                    counted_by: l.counted_by || null,
                    note: l.note || null,
                    corrected: corrections.some(c => c.count_line_id === l.id)
                }))
                .sort((a, b) => String(a.sku || '').localeCompare(String(b.sku || ''))),
            corrections
        });
    } catch (err) { sendError(res, err, 'Could not load that count.'); }
});

router.post('/counts/:sessionId/lines/:lineId', async (req, res) => {
    try {
        if (!canCorrect(req.admin)) return res.status(403).json({ error: NOT_ALLOWED });
        const session = await loadSession(req);
        if (!session) return res.status(404).json({ error: 'That count was not found.' });
        if (!isValidUUID(req.params.lineId)) return res.status(404).json({ error: 'That line is not on this count.' });

        const out = await correctCountLine({
            companyId: req.params.companyId, sessionId: session.id, lineId: req.params.lineId,
            countedQty: req.body?.counted_qty, reason: req.body?.reason, actor: actorOf(req)
        });
        await logAction(req, out.mode === 'open' ? 'count_line_changed' : 'count_corrected', 'inventory_count_session', session.id, {
            sku: out.line?.sku, name: out.line?.name, counted_qty: out.line?.counted_qty,
            qty_change: out.qty_change, reason: String(req.body?.reason || '').slice(0, 300)
        });
        res.json({
            message: out.mode === 'open'
                ? 'Count line changed. Nothing is posted until the count is committed.'
                : `Corrected. Stock ${out.qty_change > 0 ? 'up' : 'down'} ${Math.abs(out.qty_change)}, now ${out.on_hand} on hand.`,
            ...out
        });
    } catch (err) { sendError(res, err, 'Could not correct that count.'); }
});

// ------------------------------------------------------------------
// DELIVERIES
// ------------------------------------------------------------------
async function loadOrder(req) {
    const orderId = req.params.orderId;
    if (!isValidUUID(orderId)) return null;
    const scope = await orderInScope(req, orderId);
    if (!scope.ok || scope.order.company_id !== req.params.companyId) return null;
    const { data } = await supabaseAdmin.from('orders')
        .select('id, company_id, order_number, items, location_id, status')
        .eq('id', orderId).eq('company_id', req.params.companyId).maybeSingle();
    return data || null;
}

router.get('/orders/:orderId', async (req, res) => {
    try {
        const order = await loadOrder(req);
        if (!order) return res.status(404).json({ error: 'That order was not found.' });
        const out = await receivingForOrder(order);
        res.json({
            can_correct: canCorrect(req.admin),
            order: { id: order.id, order_number: order.order_number, status: order.status },
            ...out,
            lines: out.lines.map(l => ({ ...l, quantity_received: round4(l.quantity_received) }))
        });
    } catch (err) { sendError(res, err, 'Could not load what was received.'); }
});

router.post('/orders/:orderId', async (req, res) => {
    try {
        if (!canCorrect(req.admin)) return res.status(403).json({ error: NOT_ALLOWED });
        const order = await loadOrder(req);
        if (!order) return res.status(404).json({ error: 'That order was not found.' });
        const productId = req.body?.product_id;
        if (!isValidUUID(productId)) return res.status(400).json({ error: 'Pick the item to correct.' });

        const out = await correctReceipt({
            companyId: req.params.companyId, orderId: order.id, productId,
            receivedQty: req.body?.received_qty, reason: req.body?.reason, actor: actorOf(req)
        });
        await logAction(req, 'receipt_corrected', 'order', order.id, {
            order_number: order.order_number, sku: out.correction.sku, old_qty: out.correction.old_qty,
            new_qty: out.correction.new_qty, qty_change: out.qty_change, location: out.location,
            reason: out.correction.reason
        });
        res.json({
            message: `Corrected. ${out.correction.sku || 'Item'} now shows ${out.correction.new_qty} received; stock at ${out.location} ${out.qty_change > 0 ? 'up' : 'down'} ${Math.abs(out.qty_change)}.`,
            ...out
        });
    } catch (err) { sendError(res, err, 'Could not correct that delivery.'); }
});

module.exports = router;
