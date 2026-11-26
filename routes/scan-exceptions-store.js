/**
 * routes/scan-exceptions-store.js -- the shop's view of its scan issues.
 *
 * Mounted from routes/inventory-store.js at /api/store/:slug/inventory/scan-exceptions,
 * behind the same sign-in and Inventory switch. The company always comes from
 * the session, never from the URL or body.
 *
 *   GET    /                  ?location_id=&status=open|resolved|dismissed|all
 *   PATCH  /:id               { qty, note }   what was actually there (open issues only)
 *   POST   /:id/dismiss       { note? }       a mis-scan, nothing to put right
 *   POST   /:id/add           { actor_label }  a "Not in catalogue" scan that is on
 *                                             CHC's master: add it to this shop's
 *                                             list at the master list price
 *
 * Attaching a barcode or switching an item back on is done by the distributor
 * in the admin console (routes/scan-exceptions-admin.js). Adding an item that
 * is on the distributor's master list is the one fix a signed-in shop can do
 * itself (per CHC): at the master list price, with the same exclusions as a
 * Master Table push. The scan-out kiosk cannot reach these routes.
 */
const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { stripHtml, isValidUUID } = require('../utils/sanitize');
const { shapeException, NOT_INSTALLED, REASONS } = require('../utils/scan-exceptions');
const { addFromMaster, masterItem, offerOf } = require('../utils/catalogue-add');

const router = express.Router({ mergeParams: true });

const STATUSES = ['open', 'resolved', 'dismissed'];
const text = (v, max) => stripHtml(String(v === undefined || v === null ? '' : v)).trim().slice(0, max);

function notInstalled(res) {
    return res.json({ installed: false, issues: [], counts: { open: 0 } });
}

async function ownIssue(req, id) {
    if (!isValidUUID(id)) return null;
    const { data } = await supabaseAdmin.from('scan_exceptions').select('*')
        .eq('id', id).eq('company_id', req.company.id).maybeSingle();
    return data || null;
}

router.get('/', async (req, res) => {
    try {
        const status = STATUSES.includes(req.query.status) ? req.query.status : (req.query.status === 'all' ? 'all' : 'open');
        let q = supabaseAdmin.from('scan_exceptions').select('*').eq('company_id', req.company.id);
        if (req.query.location_id && isValidUUID(req.query.location_id)) q = q.eq('location_id', req.query.location_id);
        if (status !== 'all') q = q.eq('status', status);
        const { data, error } = await q.order('last_seen_at', { ascending: false }).limit(500);
        if (error) { if (NOT_INSTALLED.test(error.message || '')) return notInstalled(res); throw error; }

        let openQ = supabaseAdmin.from('scan_exceptions').select('id', { count: 'exact', head: true })
            .eq('company_id', req.company.id).eq('status', 'open');
        if (req.query.location_id && isValidUUID(req.query.location_id)) openQ = openQ.eq('location_id', req.query.location_id);
        const { count } = await openQ;

        // "Not in catalogue" issues that are on the master can be added from here.
        const issues = [];
        for (const row of data || []) {
            const shaped = shapeException(row);
            if (row.status === 'open' && row.reason === 'not_in_catalog' && row.suggested_library_id) {
                shaped.master_offer = offerOf(await masterItem(req.company.id, row.suggested_library_id));
            }
            issues.push(shaped);
        }
        res.json({ installed: true, issues, counts: { open: count || 0 }, reasons: REASONS });
    } catch (err) {
        console.error('Scan issues list error:', err);
        res.status(500).json({ error: 'Could not load scan issues.' });
    }
});

router.patch('/:id', async (req, res) => {
    try {
        const row = await ownIssue(req, req.params.id);
        if (!row) return res.status(404).json({ error: 'That scan issue was not found.' });
        if (row.status !== 'open') return res.status(409).json({ error: 'That scan issue has already been dealt with.' });

        const patch = {};
        if (req.body && req.body.qty !== undefined) {
            const qty = Number(req.body.qty);
            if (!Number.isFinite(qty) || qty <= 0 || qty > 100000) return res.status(400).json({ error: 'Enter a quantity above zero.' });
            patch.qty = Math.round(qty * 1000) / 1000;
        }
        if (req.body && req.body.note !== undefined) patch.note = text(req.body.note, 300) || null;
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change.' });

        const { data, error } = await supabaseAdmin.from('scan_exceptions').update(patch)
            .eq('id', row.id).eq('company_id', req.company.id).select('*').single();
        if (error) throw error;
        res.json({ message: 'Saved.', issue: shapeException(data) });
    } catch (err) {
        console.error('Scan issue update error:', err);
        res.status(500).json({ error: 'Could not save that.' });
    }
});

router.post('/:id/add', async (req, res) => {
    try {
        const row = await ownIssue(req, req.params.id);
        if (!row) return res.status(404).json({ error: 'That scan issue was not found.' });
        if (row.status !== 'open') return res.status(409).json({ error: 'That scan issue has already been dealt with.' });
        if (row.reason !== 'not_in_catalog' || !row.suggested_library_id) {
            return res.status(400).json({ error: 'Only an item on the master list can be added from here. Your distributor puts the others right.' });
        }
        const who = text(req.body?.actor_label, 80) || (req.companyUser && req.companyUser.name) || 'Shop';
        const added = await addFromMaster({ companyId: req.company.id, libraryId: row.suggested_library_id, code: row.code });
        if (!added.ok) return res.status(added.status).json({ error: added.error });

        const price = added.on_request ? 'price on request' : '$' + added.price.toFixed(2);
        const { data, error } = await supabaseAdmin.from('scan_exceptions').update({
            status: 'resolved', resolution: 'added_to_catalogue', resolved_product_id: added.product.id,
            resolved_at: new Date().toISOString(), resolved_by_label: who,
            note: text(`Added to the list from the master by ${who} (${price}).${row.note ? ' ' + row.note : ''}`, 300)
        }).eq('id', row.id).eq('company_id', req.company.id).select('*').single();
        if (error) throw error;
        res.json({ message: `${added.product.sku} is on your list now (${price}). Scan it again to carry on.`,
            product: added.product, issue: shapeException(data) });
    } catch (err) {
        console.error('Scan issue add error:', err);
        res.status(500).json({ error: 'Could not add that item.' });
    }
});

router.post('/:id/dismiss', async (req, res) => {
    try {
        const row = await ownIssue(req, req.params.id);
        if (!row) return res.status(404).json({ error: 'That scan issue was not found.' });
        if (row.status !== 'open') return res.status(409).json({ error: 'That scan issue has already been dealt with.' });
        const who = text(req.body?.actor_label, 80) || 'Shop';
        const note = text(req.body?.note, 300);
        const { data, error } = await supabaseAdmin.from('scan_exceptions').update({
            status: 'dismissed', resolution: 'dismissed', resolved_at: new Date().toISOString(),
            resolved_by_label: who, ...(note ? { note } : {})
        }).eq('id', row.id).eq('company_id', req.company.id).select('*').single();
        if (error) throw error;
        res.json({ message: 'Dismissed.', issue: shapeException(data) });
    } catch (err) {
        console.error('Scan issue dismiss error:', err);
        res.status(500).json({ error: 'Could not dismiss that.' });
    }
});

module.exports = router;
