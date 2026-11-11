/**
 * routes/report-groups-admin.js -- PPG paint lines vs sundries, CHC side.
 *
 *   GET    /api/admin/companies/:companyId/reports/ppg-split?location_id&from&to
 *          The same report the customer's owner sees, for any shop of the company.
 *   GET    /api/admin/report-groups/overrides              CHC's corrections (super admin)
 *   PUT    /api/admin/report-groups/overrides              { sku, group: 'ppg'|'sundries', reason }
 *   DELETE /api/admin/report-groups/overrides/:skuKey      back to the rule
 *
 * A correction applies to every customer's reports and to rebates scoped to
 * PPG paint lines or sundries, so only a super admin can make one, and each is
 * written to the audit log.
 */
const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requireCompanyAccess, requireSuperAdmin } = require('../middleware/auth');
const { isValidUUID } = require('../utils/sanitize');
const { splitReportFor, skuKey } = require('../utils/report-groups');

const router = express.Router();
const ISO_TS = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const NEEDS_063 = 'Item corrections need migration 063_report_item_groups.sql. Run it in Supabase first.';
const missing063 = err => /report_item_groups|relation .* does not exist|schema cache/i.test((err && err.message) || '');

async function audit(req, action, details) {
    try {
        await supabaseAdmin.from('audit_log').insert({
            admin_id: req.admin.id, action, entity_type: 'report_item_group', entity_id: null,
            details, ip_address: req.ip
        });
    } catch (err) { console.error('Audit log write failed:', err.message || err); }
}

router.get('/companies/:companyId/reports/ppg-split', requireCompanyAccess, async (req, res) => {
    try {
        const { companyId } = req.params;
        const { location_id, from, to } = req.query;
        if (!isValidUUID(companyId)) return res.status(400).json({ error: 'Invalid company.' });
        if (location_id && !isValidUUID(String(location_id))) return res.status(400).json({ error: 'Invalid shop.' });
        if (from && !ISO_TS.test(String(from))) return res.status(400).json({ error: 'Invalid start date.' });
        if (to && !ISO_TS.test(String(to))) return res.status(400).json({ error: 'Invalid end date.' });
        const { data: company } = await supabaseAdmin.from('companies').select('id, name').eq('id', companyId).maybeSingle();
        if (!company) return res.status(404).json({ error: 'Company not found.' });
        const report = await splitReportFor(supabaseAdmin, { companyId, locationId: location_id || null, from: from || null, to: to || null });
        res.json({ company: { id: company.id, name: company.name }, ...report });
    } catch (err) {
        console.error('Admin PPG split error:', err);
        res.status(500).json({ error: 'Failed to load the PPG and sundries report.' });
    }
});

router.get('/report-groups/overrides', requireSuperAdmin, async (req, res) => {
    const { data, error } = await supabaseAdmin.from('report_item_groups')
        .select('sku_key, sku, report_group, reason, updated_at').order('updated_at', { ascending: false }).limit(2000);
    if (error) {
        if (missing063(error)) return res.json({ overrides: [], needs_migration: NEEDS_063 });
        console.error('Overrides read error:', error);
        return res.status(500).json({ error: 'Failed to load corrections.' });
    }
    res.json({ overrides: data || [] });
});

router.put('/report-groups/overrides', requireSuperAdmin, async (req, res) => {
    const b = req.body || {};
    const sku = String(b.sku == null ? '' : b.sku).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 80);
    const key = skuKey(sku);
    if (!key) return res.status(400).json({ error: 'Enter the part number.' });
    if (b.group !== 'ppg' && b.group !== 'sundries') return res.status(400).json({ error: 'Choose PPG paint lines or sundries.' });
    const reason = String(b.reason == null ? '' : b.reason).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
    const row = { sku_key: key, sku, report_group: b.group, reason, updated_by: req.admin.id, updated_at: new Date().toISOString() };
    const { error } = await supabaseAdmin.from('report_item_groups').upsert(row, { onConflict: 'sku_key' });
    if (error) {
        if (missing063(error)) return res.status(409).json({ error: NEEDS_063 });
        console.error('Override save error:', error);
        return res.status(500).json({ error: 'Failed to save the correction.' });
    }
    await audit(req, 'report_group_set', { sku, sku_key: key, group: b.group, reason });
    res.json({ override: row });
});

router.delete('/report-groups/overrides/:skuKey', requireSuperAdmin, async (req, res) => {
    const key = skuKey(req.params.skuKey);
    if (!key) return res.status(400).json({ error: 'Invalid part number.' });
    const { error } = await supabaseAdmin.from('report_item_groups').delete().eq('sku_key', key);
    if (error) {
        if (missing063(error)) return res.status(409).json({ error: NEEDS_063 });
        console.error('Override delete error:', error);
        return res.status(500).json({ error: 'Failed to remove the correction.' });
    }
    await audit(req, 'report_group_cleared', { sku_key: key });
    res.json({ ok: true });
});

module.exports = router;
