/**
 * routes/modules-admin.js
 *
 * Which optional parts of the platform a customer has, mounted from
 * routes/admin.js at
 *   /api/admin/companies/:companyId/modules
 *
 * The parent applies requireAdminAuth; requireCompanyAccess is re-applied here.
 *
 * One endpoint for every module, driven by the registry in utils/modules.js,
 * rather than a bespoke route per feature. Adding a module is a change to the
 * registry, not to this file.
 *
 * The existing `PUT .../inventory/settings` route is untouched and still works —
 * it is the detailed settings screen for one module. This is the on/off switch
 * that all of them share.
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requireCompanyAccess } = require('../middleware/auth');
const {
    MODULES, moduleStatus, canSetModule, withModule, dependentsOf, moduleEnabled
} = require('../utils/modules');

const router = express.Router({ mergeParams: true });

router.use(requireCompanyAccess);

async function loadCompany(companyId) {
    const { data } = await supabaseAdmin
        .from('companies')
        .select('id, name, settings')
        .eq('id', companyId)
        .maybeSingle();
    return data || null;
}

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
 * GET /modules
 * Every module and where this company stands with it.
 */
router.get('/', async (req, res) => {
    try {
        const company = await loadCompany(req.params.companyId);
        if (!company) return res.status(404).json({ error: 'Company not found.' });

        res.json({
            company: { id: company.id, name: company.name },
            modules: moduleStatus(company.settings)
        });
    } catch (err) {
        console.error('Module status error:', err);
        res.status(500).json({ error: 'Failed to load modules.' });
    }
});

/**
 * PUT /modules/:name    Body: { enabled }
 *
 * Turning one on is checked against the registry — a module that is not
 * released, or whose dependencies are off, refuses with a reason rather than
 * writing a flag that would do nothing.
 *
 * Turning one off is always allowed, and never deletes anything: settings,
 * stock, history and mappings all survive, so switching back on restores the
 * customer to exactly where they were. That is a promise worth keeping, because
 * a customer who fears losing their data will never agree to try a module.
 */
router.put('/:name', async (req, res) => {
    try {
        const name = String(req.params.name || '');
        const spec = MODULES[name];
        if (!spec) return res.status(404).json({ error: `Unknown module "${name}".` });

        const company = await loadCompany(req.params.companyId);
        if (!company) return res.status(404).json({ error: 'Company not found.' });

        const enabled = req.body?.enabled === true;

        const check = canSetModule(company.settings, name, enabled);
        if (!check.ok) return res.status(400).json({ error: check.error });

        // Turning something off silently breaks whatever builds on it. Say so,
        // and require the caller to mean it.
        const collateral = enabled
            ? []
            : dependentsOf(name).filter(dep => moduleEnabled(company.settings, dep));

        if (collateral.length && req.body?.confirm_dependents !== true) {
            return res.status(409).json({
                error: `Turning ${spec.label} off also stops ${collateral.map(d => MODULES[d].label).join(' and ')}.`,
                dependents: collateral,
                hint: 'Send confirm_dependents: true to proceed. Nothing is deleted either way.'
            });
        }

        const settings = withModule(company.settings, name, { enabled });

        const { data, error } = await supabaseAdmin
            .from('companies')
            .update({ settings, updated_at: new Date().toISOString() })
            .eq('id', company.id)
            .select('id, settings')
            .single();
        if (error) throw error;

        await logAction(req.admin.id, enabled ? 'module_enabled' : 'module_disabled',
            'company', company.id, { module: name, dependents_stopped: collateral }, req.ip);

        res.json({
            message: `${spec.label} is ${enabled ? 'on' : 'off'} for ${company.name}.${enabled ? '' : ' Nothing was deleted.'}`,
            modules: moduleStatus(data.settings)
        });
    } catch (err) {
        console.error('Module toggle error:', err);
        res.status(500).json({ error: 'Failed to change that module.' });
    }
});

module.exports = router;
