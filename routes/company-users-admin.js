/**
 * routes/company-users-admin.js
 *
 * CHC-side seeding of a company's customer users, mounted from routes/admin.js at
 *   /api/admin/companies/:companyId/users
 *
 * Full-admin only and company-scoped. This is the "CHC seeds the users" path;
 * the company owner has the mirror of this in the storefront.
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requireFullAdmin, requireCompanyAccess } = require('../middleware/auth');
const cu = require('../utils/company-users');

const router = express.Router({ mergeParams: true });

router.use(requireFullAdmin, requireCompanyAccess);

async function loadCompany(req, res, next) {
    const { data: company } = await supabaseAdmin
        .from('companies').select('id, name, slug, settings').eq('id', req.params.companyId).maybeSingle();
    if (!company) return res.status(404).json({ error: 'Company not found.' });
    req.targetCompany = company;
    next();
}
router.use(loadCompany);

router.get('/', async (req, res) => {
    try {
        res.json({ users: await cu.listUsers(req.targetCompany.id), module_on: req.targetCompany.settings?.users?.enabled === true });
    } catch (err) { console.error('CHC list company users:', err); res.status(500).json({ error: 'Failed to load users.' }); }
});

router.post('/', async (req, res) => {
    try {
        const result = await cu.createUser({
            company: req.targetCompany,
            name: req.body.name, email: req.body.email,
            locationId: req.body.location_id, role: req.body.role,
            invitedBy: req.admin.id, invitedByType: 'admin'
        });
        res.status(result.status).json(result.body);
    } catch (err) { console.error('CHC create company user:', err); res.status(500).json({ error: 'Failed to create that user.' }); }
});

router.put('/:id', async (req, res) => {
    try {
        const result = await cu.updateUser({
            company: req.targetCompany, userId: req.params.id,
            patch: { name: req.body.name, role: req.body.role, location_id: req.body.location_id, is_active: req.body.is_active },
            actorUserId: null
        });
        res.status(result.status).json(result.body);
    } catch (err) { console.error('CHC update company user:', err); res.status(500).json({ error: 'Failed to update that user.' }); }
});

router.post('/:id/resend-invite', async (req, res) => {
    try {
        const result = await cu.resendInvite({ company: req.targetCompany, userId: req.params.id });
        res.status(result.status).json(result.body);
    } catch (err) { console.error('CHC resend invite:', err); res.status(500).json({ error: 'Failed to resend the invite.' }); }
});

router.delete('/:id', async (req, res) => {
    try {
        const result = await cu.deactivateUser({ company: req.targetCompany, userId: req.params.id, actorUserId: null });
        res.status(result.status).json(result.body);
    } catch (err) { console.error('CHC deactivate company user:', err); res.status(500).json({ error: 'Failed to deactivate that user.' }); }
});

module.exports = router;
