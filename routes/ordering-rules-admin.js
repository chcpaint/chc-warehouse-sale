/**
 * routes/ordering-rules-admin.js -- ordering rules for one company, in the console.
 *
 * Mounted from routes/admin.js at /api/admin/companies/:companyId/ordering-rules.
 * The same rules a shop's manager sees in the store (routes/ordering-rules-store.js);
 * CHC sets them up, adds the first approval passcode, and can change them later.
 *
 * Reading is open to anyone who can see the company. Changing anything is an
 * account-configuration change, so it needs a full admin (never order-desk,
 * which the allow-list in middleware/auth.js keeps out of this area entirely).
 * Every change is written to the audit log, never with a passcode in it.
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requireCompanyAccess, requireFullAdmin } = require('../middleware/auth');
const { isValidUUID } = require('../utils/sanitize');
const rules = require('../utils/ordering-rules');

const router = express.Router({ mergeParams: true });
router.use(requireCompanyAccess);

const NEEDS_MIGRATION = 'Ordering rules are not set up in the database yet. Run migration 071_ordering_rules.sql in Supabase first.';

async function logAction(req, action, details) {
    try {
        await supabaseAdmin.from('audit_log').insert({
            admin_id: req.admin && req.admin.id, action, entity_type: 'company',
            entity_id: req.params.companyId, details, ip_address: req.ip
        });
    } catch (err) {
        console.error('Audit log write failed:', err.message);
    }
}

async function getCompany(companyId) {
    if (!isValidUUID(companyId)) return null;
    const { data } = await supabaseAdmin.from('companies').select('id, name, settings').eq('id', companyId).maybeSingle();
    return data || null;
}

async function companyLocation(companyId, locationId) {
    if (!locationId || !isValidUUID(locationId)) return null;
    const { data } = await supabaseAdmin.from('company_locations')
        .select('id, name, is_active').eq('id', locationId).eq('company_id', companyId).maybeSingle();
    return data && data.is_active !== false ? data : null;
}

const actorOf = (req) => `${(req.admin && (req.admin.name || req.admin.email)) || 'CHC'} (console)`;

function fail(res, err, what) {
    console.error(`Ordering rules admin: ${what}:`, err && err.message);
    if (rules.missingTable(err)) return res.status(503).json({ error: NEEDS_MIGRATION });
    return res.status(500).json({ error: `Could not ${what}.` });
}

/** GET /  everything the console screen needs in one read. */
router.get('/', async (req, res) => {
    try {
        const company = await getCompany(req.params.companyId);
        if (!company) return res.status(404).json({ error: 'Company not found.' });
        const { data: locs } = await supabaseAdmin.from('company_locations')
            .select('id, name, is_active').eq('company_id', company.id).eq('is_active', true).order('name');
        const rows = await rules.loadRuleRows(company.id);
        const companyRow = rows.find(r => !r.location_id) || null;
        const passcodes = await rules.listPasscodes(company.id);
        let items = null;
        try { const g = await rules.itemGroups(company.id); items = { locked: g.locked, total: g.total }; } catch (_) { items = null; }
        const waiting = await rules.listApprovals(company.id, { status: 'waiting', limit: 50 });
        res.json({
            company: { id: company.id, name: company.name },
            manager: { name: 'CHC', location_id: null, company_wide: true },
            company_rules: companyRow,
            locations: (locs || []).map(l => {
                const own = rows.find(r => r.location_id === l.id) || null;
                return { id: l.id, name: l.name, own, effective: rules.effectiveRules(companyRow, own) };
            }),
            passcodes,
            items,
            waiting: waiting.map(a => ({ ...a, ref: rules.shortRef(a.id) })),
            default_hold_message: rules.DEFAULT_HOLD_MESSAGE,
            passcode_digits: { min: rules.PASSCODE_MIN, max: rules.PASSCODE_MAX }
        });
    } catch (err) { fail(res, err, 'load the ordering rules'); }
});

router.put('/company', requireFullAdmin, async (req, res) => {
    try {
        const company = await getCompany(req.params.companyId);
        if (!company) return res.status(404).json({ error: 'Company not found.' });
        const v = rules.normalizeRulesPatch(req.body, { forLocation: false });
        if (!v.ok) return res.status(400).json({ error: v.error });
        const row = await rules.saveRules(company.id, null, v.patch, actorOf(req));
        await logAction(req, 'ordering_rules_saved', { scope: 'company', ...v.patch });
        res.json({ message: 'Saved.', rules: row });
    } catch (err) { fail(res, err, 'save the rules'); }
});

router.put('/locations/:locationId', requireFullAdmin, async (req, res) => {
    try {
        const loc = await companyLocation(req.params.companyId, req.params.locationId);
        if (!loc) return res.status(404).json({ error: 'Location not found.' });
        const v = rules.normalizeRulesPatch(req.body, { forLocation: true });
        if (!v.ok) return res.status(400).json({ error: v.error });
        const row = await rules.saveRules(req.params.companyId, loc.id, v.patch, actorOf(req));
        await logAction(req, 'ordering_rules_saved', { scope: 'location', location: loc.name, ...v.patch });
        res.json({ message: `Saved for ${loc.name}.`, rules: row });
    } catch (err) { fail(res, err, 'save the rules for that shop'); }
});

router.post('/passcodes', requireFullAdmin, async (req, res) => {
    try {
        const company = await getCompany(req.params.companyId);
        if (!company) return res.status(404).json({ error: 'Company not found.' });
        const body = req.body || {};
        if (body.location_id && !(await companyLocation(company.id, body.location_id))) {
            return res.status(400).json({ error: 'Choose one of this company’s shops, or leave it company-wide.' });
        }
        const out = await rules.createPasscode(company.id, body, actorOf(req));
        if (!out.ok) return res.status(out.status).json({ error: out.error });
        await logAction(req, 'approval_passcode_added', { name: out.passcode.name, location_id: out.passcode.location_id });
        res.status(201).json({ message: `Passcode "${out.passcode.name}" added. Give it to that manager; it is not shown again.`, passcode: out.passcode });
    } catch (err) { fail(res, err, 'add the passcode'); }
});

router.put('/passcodes/:id', requireFullAdmin, async (req, res) => {
    try {
        if (!isValidUUID(req.params.id)) return res.status(404).json({ error: 'Passcode not found.' });
        const body = req.body || {};
        if (body.location_id && !(await companyLocation(req.params.companyId, body.location_id))) {
            return res.status(400).json({ error: 'Choose one of this company’s shops, or leave it company-wide.' });
        }
        const out = await rules.updatePasscode(req.params.companyId, req.params.id, body, actorOf(req));
        if (!out.ok) return res.status(out.status).json({ error: out.error });
        const changed = Object.keys(body).filter(k => k !== 'passcode');
        if (body.passcode) changed.push('passcode (new code)');
        await logAction(req, 'approval_passcode_changed', { name: out.passcode.name, changed });
        res.json({ message: 'Saved.', passcode: out.passcode });
    } catch (err) { fail(res, err, 'change the passcode'); }
});

router.get('/items/groups', async (req, res) => {
    try {
        res.json(await rules.itemGroups(req.params.companyId));
    } catch (err) { fail(res, err, 'load the categories'); }
});

router.get('/items', async (req, res) => {
    try {
        res.json(await rules.listItems(req.params.companyId, req.query || {}));
    } catch (err) { fail(res, err, 'load the items'); }
});

router.post('/items', requireFullAdmin, async (req, res) => {
    try {
        const out = await rules.setItems(req.params.companyId, req.body || {});
        if (!out.ok) return res.status(out.status).json({ error: out.error });
        const b = req.body || {};
        await logAction(req, 'approval_items_changed', {
            requires_approval: b.requires_approval === true, changed: out.changed,
            by: b.category ? { category: b.category } : b.brand ? { brand: b.brand } : { items: (b.product_ids || []).length }
        });
        res.json({ message: `${out.changed} item${out.changed === 1 ? '' : 's'} updated.`, changed: out.changed });
    } catch (err) { fail(res, err, 'update those items'); }
});

module.exports = router;
