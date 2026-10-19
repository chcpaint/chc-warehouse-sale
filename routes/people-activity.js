/**
 * routes/people-activity.js
 *
 * "People & activity": named groups of a customer's staff, who ordered and how
 * much, and who signed in. One implementation, mounted twice:
 *
 *   CHC console   /api/admin/companies/:companyId/people
 *   customer's    /api/store/:slug/people            (their owner only)
 *
 * Endpoints (relative to the mount)
 *   GET    /activity?from&to&location_id&group_id   the per-person / per-group report
 *   GET    /users/:userId?from&to                   one person's orders and sign-ins
 *   GET    /logins?from&to&user_id&limit            the sign-in feed
 *   GET    /groups                                  groups with member counts
 *   POST   /groups   {name}                         add a group
 *   PUT    /groups/:id {name}                       rename
 *   DELETE /groups/:id                              remove (people stay, ungrouped)
 *
 * Opt-in per company by the `activity` module. Reading is open to the guards
 * the mount supplies; creating, renaming and deleting groups to `manageGuards`.
 *
 * On the customer side every dollar figure is dropped when the company is in
 * hide-pricing (packing-slip) mode, exactly as the rest of the store does.
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { moduleEnabled } = require('../utils/modules');
const { hidePricingEnabled } = require('../utils/pricing-visibility');
const { isValidUUID } = require('../utils/sanitize');
const pa = require('../utils/people-activity');

/**
 * @param {Object} o
 * @param {Function[]} [o.readGuards]    middleware run before every route
 * @param {Function[]} [o.manageGuards]  extra middleware for group changes
 * @param {'staff'|'customer'} o.side    customer side hides dollars in hide-pricing mode
 * @param {(req)=>string} o.companyIdOf  which company this request is about
 * @param {(req, company)=>Promise<void>|void} [o.onChange]  audit hook for group changes
 */
function makePeopleRouter({ readGuards = [], manageGuards = [], side, companyIdOf, onChange }) {
    const router = express.Router({ mergeParams: true });

    router.use(...readGuards);

    router.use(async (req, res, next) => {
        try {
            const companyId = companyIdOf(req);
            if (!isValidUUID(companyId)) return res.status(400).json({ error: 'Invalid company.' });

            let q = supabaseAdmin.from('companies').select('id, name, settings, distributor_id').eq('id', companyId);
            if (req.distributor) q = q.eq('distributor_id', req.distributor.id);
            const { data: company } = await q.maybeSingle();
            if (!company) return res.status(404).json({ error: 'Company not found.' });

            if (!moduleEnabled(company.settings, 'activity')) {
                return res.status(403).json({
                    error: 'People & activity is not turned on for this company.',
                    module_off: true
                });
            }
            req.peopleCompany = company;
            req.peopleHidePricing = side === 'customer' && hidePricingEnabled(company.settings);
            next();
        } catch (err) {
            console.error('People & activity gate error:', err);
            res.status(500).json({ error: 'Could not load People & activity.' });
        }
    });

    router.get('/activity', async (req, res) => {
        try {
            const report = await pa.loadActivity({
                companyId: req.peopleCompany.id,
                from: req.query.from, to: req.query.to,
                locationId: req.query.location_id, groupId: req.query.group_id,
                hidePricing: req.peopleHidePricing
            });
            res.json({ ...report, pricing_hidden: req.peopleHidePricing });
        } catch (err) {
            console.error('People activity error:', err);
            res.status(500).json({ error: 'Could not load the activity report.' });
        }
    });

    router.get('/users/:userId', async (req, res) => {
        try {
            const result = await pa.loadPersonActivity({
                companyId: req.peopleCompany.id, userId: req.params.userId,
                from: req.query.from, to: req.query.to, hidePricing: req.peopleHidePricing
            });
            res.status(result.status).json(result.body);
        } catch (err) {
            console.error('Person activity error:', err);
            res.status(500).json({ error: 'Could not load that person.' });
        }
    });

    router.get('/logins', async (req, res) => {
        try {
            const logins = await pa.loadLoginFeed({
                companyId: req.peopleCompany.id,
                from: req.query.from, to: req.query.to,
                userId: req.query.user_id, limit: req.query.limit
            });
            res.json({ logins });
        } catch (err) {
            console.error('Sign-in feed error:', err);
            res.status(500).json({ error: 'Could not load the sign-in log.' });
        }
    });

    router.get('/groups', async (req, res) => {
        try {
            res.json({ groups: await pa.listGroups(req.peopleCompany.id) });
        } catch (err) {
            console.error('List groups error:', err);
            res.status(500).json({ error: 'Could not load groups.' });
        }
    });

    const changed = async (req, action, detail) => {
        if (!onChange) return;
        try { await onChange(req, req.peopleCompany, action, detail); }
        catch (err) { console.error('People audit failed (non-blocking):', err.message); }
    };

    router.post('/groups', ...manageGuards, async (req, res) => {
        try {
            const result = await pa.createGroup({ companyId: req.peopleCompany.id, name: req.body?.name });
            if (result.status === 201) await changed(req, 'user_group_created', { name: result.body.group.name });
            res.status(result.status).json(result.body);
        } catch (err) {
            console.error('Create group error:', err);
            res.status(500).json({ error: 'Could not create that group.' });
        }
    });

    router.put('/groups/:id', ...manageGuards, async (req, res) => {
        try {
            const result = await pa.renameGroup({ companyId: req.peopleCompany.id, groupId: req.params.id, name: req.body?.name });
            if (result.status === 200) await changed(req, 'user_group_renamed', { id: req.params.id, name: result.body.group.name });
            res.status(result.status).json(result.body);
        } catch (err) {
            console.error('Rename group error:', err);
            res.status(500).json({ error: 'Could not rename that group.' });
        }
    });

    router.delete('/groups/:id', ...manageGuards, async (req, res) => {
        try {
            const result = await pa.deleteGroup({ companyId: req.peopleCompany.id, groupId: req.params.id });
            if (result.status === 200) await changed(req, 'user_group_deleted', { id: req.params.id });
            res.status(result.status).json(result.body);
        } catch (err) {
            console.error('Delete group error:', err);
            res.status(500).json({ error: 'Could not delete that group.' });
        }
    });

    return router;
}

module.exports = { makePeopleRouter };
