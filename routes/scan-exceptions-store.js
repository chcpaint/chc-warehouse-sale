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
 *
 * Putting an issue right (attaching a barcode, adding an item to the
 * catalogue) changes the catalogue, so it is done by the distributor in the
 * admin console (routes/scan-exceptions-admin.js), not from the shop floor.
 */
const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { stripHtml, isValidUUID } = require('../utils/sanitize');
const { shapeException, NOT_INSTALLED } = require('../utils/scan-exceptions');

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

        res.json({ installed: true, issues: (data || []).map(shapeException), counts: { open: count || 0 } });
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
