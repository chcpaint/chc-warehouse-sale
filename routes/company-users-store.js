/**
 * routes/company-users-store.js
 *
 * The company owner's own view of their people, mounted from routes/storefront.js
 * at /api/store/:slug/users.
 *
 * Only reachable when the company has the Customer-users module on AND owner
 * self-service is allowed, and only by a signed-in user whose role is 'owner'.
 * Owners can invite and manage members; they cannot mint other owners (that is a
 * CHC action), and they cannot deactivate themselves.
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requireCompanyAuth, requireCompanyOwner } = require('../middleware/auth');
const cu = require('../utils/company-users');

const router = express.Router({ mergeParams: true });

router.use(requireCompanyAuth);

// The module must be on and owner self-service allowed; then require an owner.
async function gate(req, res, next) {
    const { data: company } = await supabaseAdmin
        .from('companies').select('id, name, slug, settings').eq('id', req.company.id).maybeSingle();
    if (!company) return res.status(404).json({ error: 'Company not found.' });

    const usersCfg = company.settings?.users || {};
    if (usersCfg.enabled !== true) return res.status(403).json({ error: 'User management is not enabled for this company.' });
    if (usersCfg.owner_can_invite === false) return res.status(403).json({ error: 'Owner-managed users are turned off. Contact CHC to add users.' });

    req.ownerCompany = company;
    next();
}
router.use(gate, requireCompanyOwner);

router.get('/', async (req, res) => {
    try {
        res.json({ users: await cu.listUsers(req.ownerCompany.id) });
    } catch (err) { console.error('Owner list users:', err); res.status(500).json({ error: 'Failed to load users.' }); }
});

router.post('/', async (req, res) => {
    try {
        // Owners create members only.
        const result = await cu.createUser({
            company: req.ownerCompany,
            name: req.body.name, email: req.body.email,
            locationId: req.body.location_id, role: 'member',
            invitedBy: req.companyUser.id, invitedByType: 'owner'
        });
        res.status(result.status).json(result.body);
    } catch (err) { console.error('Owner create user:', err); res.status(500).json({ error: 'Failed to invite that user.' }); }
});

router.put('/:id', async (req, res) => {
    try {
        // Owners may rename, move location, and enable/disable — not promote to owner.
        const patch = { name: req.body.name, location_id: req.body.location_id, is_active: req.body.is_active };
        const result = await cu.updateUser({ company: req.ownerCompany, userId: req.params.id, patch, actorUserId: req.companyUser.id });
        res.status(result.status).json(result.body);
    } catch (err) { console.error('Owner update user:', err); res.status(500).json({ error: 'Failed to update that user.' }); }
});

router.post('/:id/resend-invite', async (req, res) => {
    try {
        const result = await cu.resendInvite({ company: req.ownerCompany, userId: req.params.id });
        res.status(result.status).json(result.body);
    } catch (err) { console.error('Owner resend invite:', err); res.status(500).json({ error: 'Failed to resend the invite.' }); }
});

router.delete('/:id', async (req, res) => {
    try {
        const result = await cu.deactivateUser({ company: req.ownerCompany, userId: req.params.id, actorUserId: req.companyUser.id });
        res.status(result.status).json(result.body);
    } catch (err) { console.error('Owner deactivate user:', err); res.status(500).json({ error: 'Failed to deactivate that user.' }); }
});

module.exports = router;
