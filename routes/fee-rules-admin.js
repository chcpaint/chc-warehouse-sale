/**
 * routes/fee-rules-admin.js
 *
 * Fee rules (delivery fee, fuel surcharge) and rebate rules for one company,
 * mounted from routes/admin.js at
 *   /api/admin/companies/:companyId/fees-rebates
 *
 * Reading is open to anyone who can see the company; changing a rule is an
 * account-configuration change, so it needs a full admin (never order-desk).
 * Order-desk accounts are kept out of this whole area by the allow-list in
 * middleware/auth.js, and requireCompanyAccess keeps a company admin to their own
 * company.
 *
 * See utils/fee-rules.js and utils/rebates.js for what the rules mean.
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requireCompanyAccess, requireFullAdmin } = require('../middleware/auth');
const { normalizeFeeRule, loadFeeRules } = require('../utils/fee-rules');
const { normalizeRebateRule, loadRebateRules, rebateReportFor } = require('../utils/rebates');
const { isValidUUID } = require('../utils/sanitize');
const { deliveryFeeSettings } = require('../utils/delivery-fee');

const router = express.Router({ mergeParams: true });
router.use(requireCompanyAccess);

async function logAction(adminId, action, entityType, entityId, details, ip) {
    try {
        await supabaseAdmin.from('audit_log').insert({
            admin_id: adminId, action, entity_type: entityType,
            entity_id: entityId, details, ip_address: ip
        });
    } catch (err) {
        console.error('Audit log write failed:', err);
    }
}

async function getCompany(companyId) {
    if (!isValidUUID(companyId)) return null;
    const { data } = await supabaseAdmin.from('companies').select('id, name, settings').eq('id', companyId).maybeSingle();
    return data || null;
}

/** Tell a missing migration apart from a real failure, so the screen can say what to do. */
function missingTable(err) {
    return /company_fee_rules|company_rebate_rules|relation .* does not exist|schema cache/i.test((err && err.message) || '');
}
const NEEDS_MIGRATION = 'Fee and rebate rules are not set up in the database yet. Run migration 047_fee_rules_and_rebates.sql in Supabase first.';

/** GET /  everything the screen needs in one read. */
router.get('/', async (req, res) => {
    try {
        const company = await getCompany(req.params.companyId);
        if (!company) return res.status(404).json({ error: 'Company not found.' });

        const [feeRules, rebateRules, groups, products] = await Promise.all([
            loadFeeRules(supabaseAdmin, company.id),
            loadRebateRules(supabaseAdmin, company.id),
            supabaseAdmin.from('company_user_groups').select('id, name').eq('company_id', company.id).order('name'),
            supabaseAdmin.from('products').select('brand, category').eq('company_id', company.id).eq('is_active', true).limit(5000)
        ]);
        const uniq = key => [...new Set((products.data || []).map(p => p[key]).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));

        res.json({
            company: { id: company.id, name: company.name },
            fee_rules: feeRules,
            rebate_rules: rebateRules,
            // With no rules at all the old setting decides (the $10 fee under $300, unless turned off).
            fee_mode: feeRules.length ? 'rules' : 'legacy',
            legacy_delivery_fee_enabled: deliveryFeeSettings(company.settings).enabled,
            groups: groups.data || [],
            categories: uniq('category'),
            brands: uniq('brand'),
            can_manage: ['super_admin', 'admin'].includes(req.admin && req.admin.role)
        });
    } catch (err) {
        console.error('Fees & rebates read error:', err);
        res.status(500).json({ error: 'Failed to load fee and rebate settings.' });
    }
});

/** A chosen group must belong to this company. */
async function groupsAreValid(companyId, ids) {
    if (!ids.length) return true;
    const { data } = await supabaseAdmin.from('company_user_groups').select('id').eq('company_id', companyId).in('id', ids);
    return (data || []).length === ids.length;
}

// ------------------------------------------------------------------
// Fee rules
// ------------------------------------------------------------------
router.post('/fee-rules', requireFullAdmin, async (req, res) => {
    try {
        const company = await getCompany(req.params.companyId);
        if (!company) return res.status(404).json({ error: 'Company not found.' });
        const { value, error } = normalizeFeeRule(req.body);
        if (error) return res.status(400).json({ error });
        if (!(await groupsAreValid(company.id, value.group_ids))) return res.status(400).json({ error: 'One of the chosen user groups does not belong to this company.' });

        const { data, error: dbErr } = await supabaseAdmin.from('company_fee_rules')
            .insert({ company_id: company.id, ...value }).select().single();
        if (dbErr) { if (missingTable(dbErr)) return res.status(409).json({ error: NEEDS_MIGRATION }); throw dbErr; }
        await logAction(req.admin.id, 'fee_rule_created', 'company', company.id, { rule: value }, req.ip);
        res.status(201).json({ message: `${value.label} added for ${company.name}.`, rule: data });
    } catch (err) {
        console.error('Fee rule create error:', err);
        res.status(500).json({ error: 'Failed to save the fee rule.' });
    }
});

router.put('/fee-rules/:ruleId', requireFullAdmin, async (req, res) => {
    try {
        const company = await getCompany(req.params.companyId);
        if (!company) return res.status(404).json({ error: 'Company not found.' });
        if (!isValidUUID(req.params.ruleId)) return res.status(400).json({ error: 'Invalid rule.' });
        const { data: existing } = await supabaseAdmin.from('company_fee_rules').select('*')
            .eq('id', req.params.ruleId).eq('company_id', company.id).maybeSingle();
        if (!existing) return res.status(404).json({ error: 'Rule not found.' });

        const { value, error } = normalizeFeeRule({ ...existing, ...req.body });
        if (error) return res.status(400).json({ error });
        if (!(await groupsAreValid(company.id, value.group_ids))) return res.status(400).json({ error: 'One of the chosen user groups does not belong to this company.' });

        const { data, error: dbErr } = await supabaseAdmin.from('company_fee_rules')
            .update({ ...value, updated_at: new Date().toISOString() })
            .eq('id', existing.id).eq('company_id', company.id).select().single();
        if (dbErr) throw dbErr;
        await logAction(req.admin.id, 'fee_rule_updated', 'company', company.id, { rule_id: existing.id, rule: value }, req.ip);
        res.json({ message: 'Fee rule saved.', rule: data });
    } catch (err) {
        console.error('Fee rule update error:', err);
        res.status(500).json({ error: 'Failed to save the fee rule.' });
    }
});

router.delete('/fee-rules/:ruleId', requireFullAdmin, async (req, res) => {
    try {
        const company = await getCompany(req.params.companyId);
        if (!company) return res.status(404).json({ error: 'Company not found.' });
        if (!isValidUUID(req.params.ruleId)) return res.status(400).json({ error: 'Invalid rule.' });
        const { data: existing } = await supabaseAdmin.from('company_fee_rules').select('id, label')
            .eq('id', req.params.ruleId).eq('company_id', company.id).maybeSingle();
        if (!existing) return res.status(404).json({ error: 'Rule not found.' });

        const { error: dbErr } = await supabaseAdmin.from('company_fee_rules').delete()
            .eq('id', existing.id).eq('company_id', company.id);
        if (dbErr) throw dbErr;

        // A company with no rules at all falls back to the old $10-under-$300 setting. Someone who
        // deletes their last rule means "no fees", not "bring the old fee back", so say so explicitly.
        const remaining = await loadFeeRules(supabaseAdmin, company.id);
        let note = '';
        if (!remaining.length) {
            await supabaseAdmin.from('companies')
                .update({ settings: { ...(company.settings || {}), delivery_fee: { enabled: false } }, updated_at: new Date().toISOString() })
                .eq('id', company.id);
            note = ` ${company.name} has no fee rules left, so it will not be charged a delivery fee or fuel surcharge.`;
        }
        await logAction(req.admin.id, 'fee_rule_deleted', 'company', company.id, { rule_id: existing.id, label: existing.label }, req.ip);
        res.json({ message: `Removed ${existing.label}.${note}` });
    } catch (err) {
        console.error('Fee rule delete error:', err);
        res.status(500).json({ error: 'Failed to remove the fee rule.' });
    }
});

// ------------------------------------------------------------------
// Rebate rules
// ------------------------------------------------------------------
router.post('/rebate-rules', requireFullAdmin, async (req, res) => {
    try {
        const company = await getCompany(req.params.companyId);
        if (!company) return res.status(404).json({ error: 'Company not found.' });
        const { value, error } = normalizeRebateRule(req.body);
        if (error) return res.status(400).json({ error });
        const { data, error: dbErr } = await supabaseAdmin.from('company_rebate_rules')
            .insert({ company_id: company.id, ...value }).select().single();
        if (dbErr) { if (missingTable(dbErr)) return res.status(409).json({ error: NEEDS_MIGRATION }); throw dbErr; }
        await logAction(req.admin.id, 'rebate_rule_created', 'company', company.id, { rule: value }, req.ip);
        res.status(201).json({ message: `${value.label} added for ${company.name}. It now shows in their reports.`, rule: data });
    } catch (err) {
        console.error('Rebate rule create error:', err);
        res.status(500).json({ error: 'Failed to save the rebate rule.' });
    }
});

router.put('/rebate-rules/:ruleId', requireFullAdmin, async (req, res) => {
    try {
        const company = await getCompany(req.params.companyId);
        if (!company) return res.status(404).json({ error: 'Company not found.' });
        if (!isValidUUID(req.params.ruleId)) return res.status(400).json({ error: 'Invalid rule.' });
        const { data: existing } = await supabaseAdmin.from('company_rebate_rules').select('*')
            .eq('id', req.params.ruleId).eq('company_id', company.id).maybeSingle();
        if (!existing) return res.status(404).json({ error: 'Rule not found.' });
        const { value, error } = normalizeRebateRule({ ...existing, ...req.body });
        if (error) return res.status(400).json({ error });
        const { data, error: dbErr } = await supabaseAdmin.from('company_rebate_rules')
            .update({ ...value, updated_at: new Date().toISOString() })
            .eq('id', existing.id).eq('company_id', company.id).select().single();
        if (dbErr) throw dbErr;
        await logAction(req.admin.id, 'rebate_rule_updated', 'company', company.id, { rule_id: existing.id, rule: value }, req.ip);
        res.json({ message: 'Rebate rule saved.', rule: data });
    } catch (err) {
        console.error('Rebate rule update error:', err);
        res.status(500).json({ error: 'Failed to save the rebate rule.' });
    }
});

router.delete('/rebate-rules/:ruleId', requireFullAdmin, async (req, res) => {
    try {
        const company = await getCompany(req.params.companyId);
        if (!company) return res.status(404).json({ error: 'Company not found.' });
        if (!isValidUUID(req.params.ruleId)) return res.status(400).json({ error: 'Invalid rule.' });
        const { data: existing } = await supabaseAdmin.from('company_rebate_rules').select('id, label')
            .eq('id', req.params.ruleId).eq('company_id', company.id).maybeSingle();
        if (!existing) return res.status(404).json({ error: 'Rule not found.' });
        const { error: dbErr } = await supabaseAdmin.from('company_rebate_rules').delete()
            .eq('id', existing.id).eq('company_id', company.id);
        if (dbErr) throw dbErr;
        await logAction(req.admin.id, 'rebate_rule_deleted', 'company', company.id, { rule_id: existing.id, label: existing.label }, req.ip);
        res.json({ message: `Removed ${existing.label}.` });
    } catch (err) {
        console.error('Rebate rule delete error:', err);
        res.status(500).json({ error: 'Failed to remove the rebate rule.' });
    }
});

/**
 * GET /rebate-report?from=ISO&to=ISO   (defaults to the current calendar year, Toronto time)
 * What this company has earned, by rule and period. Same numbers the company sees.
 */
router.get('/rebate-report', async (req, res) => {
    try {
        const company = await getCompany(req.params.companyId);
        if (!company) return res.status(404).json({ error: 'Company not found.' });
        const { from, to } = req.query;
        const report = await rebateReportFor(supabaseAdmin, { companyId: company.id, from, to });
        res.json({ company: { id: company.id, name: company.name }, ...report });
    } catch (err) {
        console.error('Rebate report error:', err);
        res.status(500).json({ error: 'Failed to build the rebate report.' });
    }
});

module.exports = router;
