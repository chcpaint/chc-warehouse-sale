/**
 * routes/tax-admin.js
 *
 * Sales tax configuration, mounted from routes/admin.js at
 *   /api/admin/companies/:companyId/tax
 *
 * Two things CHC can set per customer: the rate applied to their orders, and
 * whether they are exempt entirely. Everyone defaults to 13% (Ontario HST) —
 * see utils/tax.js for why, and for the rule the storefront actually bills by.
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requireCompanyAccess } = require('../middleware/auth');
const { taxSettings, validateRate, DEFAULT_RATE } = require('../utils/tax');

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

/**
 * GET /tax
 * The current rate/exemption for this company, and what everyone gets by
 * default so the admin screen can show "13% (default)" rather than making it
 * look like someone chose that number on purpose.
 */
router.get('/', async (req, res) => {
    try {
        const companyId = req.params.companyId;

        const { data: company } = await supabaseAdmin
            .from('companies').select('id, name, settings').eq('id', companyId).maybeSingle();
        if (!company) return res.status(404).json({ error: 'Company not found.' });

        const settings = taxSettings(company.settings);

        res.json({
            company: { id: company.id, name: company.name },
            rate: settings.rate,
            exempt: settings.exempt,
            is_default: settings.is_default,
            default_rate: DEFAULT_RATE
        });
    } catch (err) {
        console.error('Tax config read error:', err);
        res.status(500).json({ error: 'Failed to load tax settings.' });
    }
});

/**
 * PUT /tax    Body: { rate?, exempt? }
 *
 * `rate: null` (or '' or omitted) clears any override and goes back to the
 * default. `exempt: true` zeroes the rate regardless of what's on file —
 * kept separately from rate 0 so a customer's exemption certificate can be
 * turned off later without CHC having to remember and re-type whatever rate
 * they were on before it existed.
 */
router.put('/', async (req, res) => {
    try {
        const companyId = req.params.companyId;

        const { data: company } = await supabaseAdmin
            .from('companies').select('id, name, settings').eq('id', companyId).maybeSingle();
        if (!company) return res.status(404).json({ error: 'Company not found.' });

        const exempt = req.body?.exempt === true;

        const rateCheck = validateRate(req.body?.rate);
        if (!rateCheck.ok) return res.status(400).json({ error: rateCheck.error });

        const taxBlock = {};
        if (exempt) taxBlock.exempt = true;
        if (rateCheck.rate !== undefined) taxBlock.rate = rateCheck.rate;

        const settings = {
            ...(company.settings || {}),
            tax: taxBlock
        };

        const { error: companyError } = await supabaseAdmin
            .from('companies')
            .update({ settings, updated_at: new Date().toISOString() })
            .eq('id', companyId);
        if (companyError) throw companyError;

        await logAction(req.admin.id, 'tax_settings_updated', 'company', companyId,
            { exempt, rate: rateCheck.rate ?? null }, req.ip);

        const resolved = taxSettings(settings);
        res.json({
            message: resolved.exempt
                ? `${company.name} is now tax-exempt.`
                : resolved.is_default
                    ? `${company.name} will be charged tax at the default rate of ${(DEFAULT_RATE * 100).toFixed(0)}%.`
                    : `${company.name} will be charged tax at ${(resolved.rate * 100).toFixed(2).replace(/\.?0+$/, '')}%.`,
            rate: resolved.rate,
            exempt: resolved.exempt,
            is_default: resolved.is_default
        });
    } catch (err) {
        console.error('Tax config write error:', err);
        res.status(500).json({ error: 'Failed to save tax settings.' });
    }
});

module.exports = router;
