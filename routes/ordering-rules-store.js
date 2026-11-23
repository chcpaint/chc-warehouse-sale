/**
 * routes/ordering-rules-store.js -- ordering rules and manager approvals, in the shop.
 *
 * Mounted from routes/storefront.js at /api/store/:slug/ordering-rules.
 *
 *   GET  /status                 what applies to this shop now (any session)
 *   GET  /approvals              orders waiting for a manager at this shop
 *   GET  /approvals/:id          one, re-priced now, with the reasons as they stand now
 *   POST /approvals/:id/release  { passcode }          send it to CHC
 *   POST /approvals/:id/decline  { passcode, reason }  close it without ordering
 *
 *   POST /unlock                 { passcode, location_id } -> a 30-minute rules session
 *   GET  /manage                 the rules screen (owner login, or a rules session)
 *   PUT  /company                company-wide defaults            (company-wide manager)
 *   PUT  /locations/:locationId  one shop's own settings          (that shop's manager too)
 *   POST /passcodes, PUT /passcodes/:id                           (company-wide manager)
 *   GET  /items, GET /items/groups, POST /items                   (company-wide manager)
 *
 * Who is a manager here: an owner signed in with their own login, or anyone
 * who types an approval passcode. A passcode limited to one shop manages and
 * approves for that shop only, and cannot see or change the passcodes. That is
 * enforced on every call, never by hiding a button: a rules session is
 * re-checked against the passcode on each request, so switching a passcode off
 * ends every session it opened.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../utils/supabase');
const { requireCompanyAuth } = require('../middleware/auth');
const { isValidUUID } = require('../utils/sanitize');
const rules = require('../utils/ordering-rules');

const SESSION_SECONDS = 30 * 60;

function text(v, max) {
    return String(v === undefined || v === null ? '' : v).replace(/<[^>]*>/g, '').trim().slice(0, max);
}

/** An active location of this company, or null. */
async function companyLocation(companyId, locationId) {
    if (!locationId || !isValidUUID(locationId)) return null;
    const { data } = await supabaseAdmin.from('company_locations')
        .select('id, name, is_active').eq('id', locationId).eq('company_id', companyId).maybeSingle();
    return data && data.is_active !== false ? data : null;
}

/** The shop this session works at: a person tied to one shop always gets theirs. */
function sessionLocationId(req, asked) {
    if (req.companyUser && req.companyUser.location_id) return req.companyUser.location_id;
    return asked || null;
}

function makeOrderingRulesRouter({ placeOrder }) {
    const router = express.Router({ mergeParams: true });
    router.use(requireCompanyAuth);

    // ------------------------------------------------------------------
    // Who is managing: owner login, or a rules session from /unlock.
    // ------------------------------------------------------------------
    async function manager(req) {
        if (req.companyUser && req.companyUser.role === 'owner') {
            return { name: req.companyUser.name || 'Owner', location_id: req.companyUser.location_id || null, via: 'owner' };
        }
        const raw = req.headers['x-rules-token'];
        if (!raw) return null;
        try {
            const d = jwt.verify(String(raw), process.env.JWT_SECRET, { algorithms: ['HS256'] });
            if (d.type !== 'rules_manage' || d.company_id !== req.company.id) return null;
            const { data: p } = await supabaseAdmin.from('approval_passcodes')
                .select('id, name, location_id, is_active').eq('id', d.passcode_id).eq('company_id', req.company.id).maybeSingle();
            if (!p || !p.is_active) return null;
            return { name: p.name, location_id: p.location_id || null, passcode_id: p.id, via: 'passcode' };
        } catch (_) { return null; }
    }

    async function requireManager(req, res, { companyWide = false } = {}) {
        const m = await manager(req);
        if (!m) { res.status(401).json({ error: 'Enter an approval passcode to manage ordering rules.', unlock_required: true }); return null; }
        if (companyWide && m.location_id) {
            res.status(403).json({ error: `The passcode "${m.name}" is for one shop only. A company-wide passcode or an owner can change this.` });
            return null;
        }
        return m;
    }

    // ------------------------------------------------------------------
    // STATUS -- what this shop's screens need to show.
    // ------------------------------------------------------------------
    router.get('/status', async (req, res) => {
        try {
            const companyId = req.company.id;
            const loc = await companyLocation(companyId, sessionLocationId(req, req.query.location_id));
            const { rules: effective } = await rules.rulesFor(companyId, loc ? loc.id : null);
            const passcodes = loc ? await rules.activePasscodes(companyId, loc.id).catch(() => []) : [];
            res.json({
                rules: effective,
                any_on: rules.anyOn(effective),
                has_passcodes: passcodes.length > 0,
                waiting: loc ? await rules.waitingCount(companyId, loc.id) : 0,
                is_owner: !!(req.companyUser && req.companyUser.role === 'owner')
            });
        } catch (err) {
            console.error('Ordering rules status error:', err);
            res.status(500).json({ error: 'Could not load the ordering rules.' });
        }
    });

    // ------------------------------------------------------------------
    // WAITING FOR APPROVAL
    // ------------------------------------------------------------------
    router.get('/approvals', async (req, res) => {
        try {
            const companyId = req.company.id;
            const loc = await companyLocation(companyId, sessionLocationId(req, req.query.location_id));
            if (!loc) return res.status(400).json({ error: 'Choose your location first.' });
            const waiting = await rules.listApprovals(companyId, { locationId: loc.id, status: 'waiting' });
            const recent = (await rules.listApprovals(companyId, { locationId: loc.id, status: null, limit: 30 }))
                .filter(a => a.status !== 'waiting').slice(0, 10);
            const tag = (a) => ({ ...a, ref: rules.shortRef(a.id) });
            res.json({ location: loc, waiting: waiting.map(tag), recent: recent.map(tag) });
        } catch (err) {
            console.error('Approvals list error:', err);
            res.status(500).json({ error: 'Could not load the orders waiting for approval.' });
        }
    });

    async function loadApproval(req) {
        if (!isValidUUID(req.params.id)) return null;
        const { data } = await supabaseAdmin.from('order_approvals')
            .select(rules.APPROVAL_COLUMNS + ', request, requested_by')
            .eq('id', req.params.id).eq('company_id', req.company.id).maybeSingle();
        if (!data) return null;
        // A person tied to one shop sees that shop's only.
        if (req.companyUser && req.companyUser.location_id && data.location_id !== req.companyUser.location_id) return null;
        return data;
    }

    /** The request as it would be placed now, by whoever asked for it. */
    function replayRequest(req, row) {
        const who = row.requested_by;
        return {
            company: req.company,
            distributor: req.distributor,
            companyUser: who && who.id ? {
                id: who.id, name: who.name || null, email: who.email || null,
                role: who.role || 'member', location_id: who.location_id || null
            } : null
        };
    }

    router.get('/approvals/:id', async (req, res) => {
        try {
            const row = await loadApproval(req);
            if (!row) return res.status(404).json({ error: 'That order is not waiting here.' });
            let preview = null, preview_error = null;
            if (row.status === 'waiting') {
                const out = await placeOrder(replayRequest(req, row), row.request, { preview: true });
                if (out.status === 200 && out.body.preview) preview = out.body.preview;
                else preview_error = (out.body && out.body.error) || 'This order cannot be placed as it is.';
            }
            const { request, requested_by, ...shown } = row;
            res.json({ approval: { ...shown, ref: rules.shortRef(row.id), notes: request && request.notes || '', po_number: request && request.po_number || null },
                preview, preview_error });
        } catch (err) {
            console.error('Approval detail error:', err);
            res.status(500).json({ error: 'Could not load that order.' });
        }
    });

    router.post('/approvals/:id/release', async (req, res) => {
        try {
            const companyId = req.company.id;
            const row = await loadApproval(req);
            if (!row) return res.status(404).json({ error: 'That order is not waiting here.' });
            if (row.status !== 'waiting') return res.status(409).json({ error: `That order was already ${row.status}.` });

            const check = await rules.verifyApprovalPasscode(companyId, row.location_id, req.body && req.body.passcode);
            if (!check.ok) return res.status(check.status).json({ error: check.error, attempts_left: check.attempts_left, locked_seconds: check.locked_seconds });

            // Claim it first, so two managers pressing Release at once send it once.
            const at = new Date().toISOString();
            const { data: claimed } = await supabaseAdmin.from('order_approvals')
                .update({ status: 'released', decided_at: at, decided_by_name: check.passcode.name, decided_by_passcode: check.passcode.id })
                .eq('id', row.id).eq('status', 'waiting').select('id');
            if (!claimed || !claimed.length) return res.status(409).json({ error: 'Someone else has just dealt with that order.' });

            const out = await placeOrder(replayRequest(req, row), row.request, {
                approval: { via: 'release', approved_by: check.passcode.name, passcode_id: check.passcode.id, approval_id: row.id,
                    requested_at: row.created_at }
            });

            if (out.status !== 201) {
                // Could not be placed (an item gone, a PO used since): put it back as it was.
                await supabaseAdmin.from('order_approvals')
                    .update({ status: 'waiting', decided_at: null, decided_by_name: null, decided_by_passcode: null })
                    .eq('id', row.id);
                return res.status(out.status).json(out.body);
            }

            await supabaseAdmin.from('order_approvals').update({ order_id: out.body.order.id }).eq('id', row.id);
            res.status(201).json({ released: true, approved_by: check.passcode.name, ...out.body });
        } catch (err) {
            console.error('Approval release error:', err);
            res.status(500).json({ error: 'Could not release that order. Try again.' });
        }
    });

    router.post('/approvals/:id/decline', async (req, res) => {
        try {
            const companyId = req.company.id;
            const row = await loadApproval(req);
            if (!row) return res.status(404).json({ error: 'That order is not waiting here.' });
            if (row.status !== 'waiting') return res.status(409).json({ error: `That order was already ${row.status}.` });
            const reason = text(req.body && req.body.reason, 300);
            if (!reason) return res.status(400).json({ error: 'Say why it is declined, so the person who asked knows.' });

            const check = await rules.verifyApprovalPasscode(companyId, row.location_id, req.body && req.body.passcode);
            if (!check.ok) return res.status(check.status).json({ error: check.error, attempts_left: check.attempts_left, locked_seconds: check.locked_seconds });

            const { data } = await supabaseAdmin.from('order_approvals')
                .update({ status: 'declined', decided_at: new Date().toISOString(), decided_by_name: check.passcode.name,
                    decided_by_passcode: check.passcode.id, decision_reason: reason })
                .eq('id', row.id).eq('status', 'waiting').select('id, status');
            if (!data || !data.length) return res.status(409).json({ error: 'Someone else has just dealt with that order.' });
            res.json({ declined: true, declined_by: check.passcode.name });
        } catch (err) {
            console.error('Approval decline error:', err);
            res.status(500).json({ error: 'Could not decline that order. Try again.' });
        }
    });

    // ------------------------------------------------------------------
    // MANAGING THE RULES
    // ------------------------------------------------------------------
    router.post('/unlock', async (req, res) => {
        try {
            const companyId = req.company.id;
            const loc = await companyLocation(companyId, sessionLocationId(req, req.body && req.body.location_id));
            const check = await rules.verifyApprovalPasscode(companyId, loc ? loc.id : null, req.body && req.body.passcode);
            if (!check.ok) return res.status(check.status).json({ error: check.error, attempts_left: check.attempts_left, locked_seconds: check.locked_seconds });
            const token = jwt.sign({ type: 'rules_manage', company_id: companyId, passcode_id: check.passcode.id },
                process.env.JWT_SECRET, { expiresIn: SESSION_SECONDS });
            res.json({ token, expires_in: SESSION_SECONDS, name: check.passcode.name, location_id: check.passcode.location_id });
        } catch (err) {
            console.error('Rules unlock error:', err);
            res.status(500).json({ error: 'Could not check the passcode. Try again.' });
        }
    });

    router.get('/manage', async (req, res) => {
        try {
            const m = await requireManager(req, res);
            if (!m) return;
            const companyId = req.company.id;
            const { data: locs } = await supabaseAdmin.from('company_locations')
                .select('id, name, is_active').eq('company_id', companyId).eq('is_active', true).order('name');
            const shops = (locs || []).filter(l => !m.location_id || l.id === m.location_id);
            const rows = await rules.loadRuleRows(companyId);
            const companyRow = rows.find(r => !r.location_id) || null;
            res.json({
                manager: { name: m.name, location_id: m.location_id, company_wide: !m.location_id },
                company_rules: companyRow,
                default_hold_message: rules.DEFAULT_HOLD_MESSAGE,
                locations: shops.map(l => ({
                    id: l.id, name: l.name,
                    own: rows.find(r => r.location_id === l.id) || null,
                    effective: rules.effectiveRules(companyRow, rows.find(r => r.location_id === l.id) || null)
                })),
                passcodes: m.location_id ? null : await rules.listPasscodes(companyId),
                items: m.location_id ? null : await rules.itemGroups(companyId).then(g => ({ locked: g.locked, total: g.total })).catch(() => null)
            });
        } catch (err) {
            console.error('Rules manage error:', err);
            res.status(500).json({ error: 'Could not load the ordering rules.' });
        }
    });

    router.put('/company', async (req, res) => {
        try {
            const m = await requireManager(req, res, { companyWide: true });
            if (!m) return;
            const v = rules.normalizeRulesPatch(req.body, { forLocation: false });
            if (!v.ok) return res.status(400).json({ error: v.error });
            const row = await rules.saveRules(req.company.id, null, v.patch, m.name);
            res.json({ message: 'Saved.', company: row });
        } catch (err) {
            console.error('Rules save error:', err);
            res.status(rules.missingTable(err) ? 503 : 500).json({ error: rules.missingTable(err)
                ? 'Ordering rules are not set up in the database yet (migration 071).' : 'Could not save the rules.' });
        }
    });

    router.put('/locations/:locationId', async (req, res) => {
        try {
            const m = await requireManager(req, res);
            if (!m) return;
            const loc = await companyLocation(req.company.id, req.params.locationId);
            if (!loc) return res.status(404).json({ error: 'Location not found.' });
            if (m.location_id && m.location_id !== loc.id) return res.status(403).json({ error: 'That passcode is for another shop.' });
            const v = rules.normalizeRulesPatch(req.body, { forLocation: true });
            if (!v.ok) return res.status(400).json({ error: v.error });
            const row = await rules.saveRules(req.company.id, loc.id, v.patch, m.name);
            res.json({ message: 'Saved.', location: row });
        } catch (err) {
            console.error('Rules save (location) error:', err);
            res.status(500).json({ error: 'Could not save the rules for that shop.' });
        }
    });

    router.post('/passcodes', async (req, res) => {
        try {
            const m = await requireManager(req, res, { companyWide: true });
            if (!m) return;
            const body = req.body || {};
            if (body.location_id && !(await companyLocation(req.company.id, body.location_id))) {
                return res.status(400).json({ error: 'Choose one of your shops, or leave it company-wide.' });
            }
            const out = await rules.createPasscode(req.company.id, body, m.name);
            if (!out.ok) return res.status(out.status).json({ error: out.error });
            res.status(201).json({ message: `Passcode "${out.passcode.name}" added.`, passcode: out.passcode });
        } catch (err) {
            console.error('Passcode create error:', err);
            res.status(500).json({ error: 'Could not add the passcode.' });
        }
    });

    router.put('/passcodes/:id', async (req, res) => {
        try {
            const m = await requireManager(req, res, { companyWide: true });
            if (!m) return;
            if (!isValidUUID(req.params.id)) return res.status(404).json({ error: 'Passcode not found.' });
            const body = req.body || {};
            if (body.location_id && !(await companyLocation(req.company.id, body.location_id))) {
                return res.status(400).json({ error: 'Choose one of your shops, or leave it company-wide.' });
            }
            // A manager switching off the passcode they are using would lock
            // themselves out mid-change; say so rather than do it.
            if (m.passcode_id === req.params.id && body.is_active === false) {
                return res.status(400).json({ error: 'You are signed in with this passcode. Use another company-wide passcode to switch it off.' });
            }
            const out = await rules.updatePasscode(req.company.id, req.params.id, body, m.name);
            if (!out.ok) return res.status(out.status).json({ error: out.error });
            res.json({ message: 'Saved.', passcode: out.passcode });
        } catch (err) {
            console.error('Passcode update error:', err);
            res.status(500).json({ error: 'Could not change the passcode.' });
        }
    });

    router.get('/items', async (req, res) => {
        try {
            const m = await requireManager(req, res, { companyWide: true });
            if (!m) return;
            res.json(await rules.listItems(req.company.id, req.query || {}));
        } catch (err) {
            console.error('Rules items error:', err);
            res.status(500).json({ error: 'Could not load the items.' });
        }
    });

    router.get('/items/groups', async (req, res) => {
        try {
            const m = await requireManager(req, res, { companyWide: true });
            if (!m) return;
            res.json(await rules.itemGroups(req.company.id));
        } catch (err) {
            console.error('Rules item groups error:', err);
            res.status(500).json({ error: 'Could not load the categories.' });
        }
    });

    router.post('/items', async (req, res) => {
        try {
            const m = await requireManager(req, res, { companyWide: true });
            if (!m) return;
            const out = await rules.setItems(req.company.id, req.body || {});
            if (!out.ok) return res.status(out.status).json({ error: out.error });
            res.json({ message: `${out.changed} item${out.changed === 1 ? '' : 's'} updated.`, changed: out.changed });
        } catch (err) {
            console.error('Rules items save error:', err);
            res.status(500).json({ error: 'Could not update those items.' });
        }
    });

    return router;
}

module.exports = { makeOrderingRulesRouter };
