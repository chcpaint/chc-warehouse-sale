/**
 * routes/shopsafe-launch.js
 *
 * POST /api/store/:slug/shopsafe/launch
 *
 * Returns a one-time URL that signs the current customer into RefinishAI
 * ShopSafe. Only for companies with the `shopsafe` module switched on.
 * See utils/shopsafe.js for the hand-off design.
 */
const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requireCompanyAuth } = require('../middleware/auth');
const { moduleEnabled } = require('../utils/modules');
const { buildLaunchUrl, shopsafeConfigured } = require('../utils/shopsafe');

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post('/:slug/shopsafe/launch', requireCompanyAuth, async (req, res) => {
    try {
        if (req.company.slug !== req.params.slug) {
            return res.status(403).json({ error: 'Access denied.' });
        }
        if (!shopsafeConfigured()) {
            return res.status(503).json({ error: 'ShopSafe is not available yet.' });
        }

        const { data: company } = await supabaseAdmin
            .from('companies')
            .select('id, name, settings, contact_email, distributor_id, is_active')
            .eq('id', req.company.id)
            .single();
        if (!company || !company.is_active) return res.status(404).json({ error: 'Company not found.' });
        if (!moduleEnabled(company.settings, 'shopsafe')) {
            return res.status(403).json({ error: 'ShopSafe is not switched on for this account. Ask your CHC rep.' });
        }

        // An individual login is reloaded rather than trusted from its 24-hour
        // token, so a deactivated or reassigned person cannot keep opening
        // ShopSafe with yesterday's access.
        let person = null;
        if (req.companyUser) {
            const { data } = await supabaseAdmin
                .from('company_users')
                .select('id, email, name, role, location_id, is_active')
                .eq('id', req.companyUser.id)
                .eq('company_id', company.id)
                .maybeSingle();
            if (!data || !data.is_active) return res.status(401).json({ error: 'Your account is not active.' });
            person = data;
        }

        // An individual user is pinned to their own location; the shared
        // company session uses the location it selected on entry.
        const locationId = (person && person.location_id) || req.body.location_id || null;
        let location = null;
        if (locationId) {
            if (!UUID.test(String(locationId))) return res.status(400).json({ error: 'Invalid location.' });
            const { data } = await supabaseAdmin
                .from('company_locations')
                .select('id, name, province')
                .eq('id', locationId)
                .eq('company_id', company.id)
                .eq('is_active', true)
                .maybeSingle();
            if (!data) return res.status(400).json({ error: 'Selected location is not valid for this account.' });
            location = data;
        } else {
            // Each location is its own ShopSafe shop. Opening without one would
            // create a company-wide shop beside them and split the records.
            const { count } = await supabaseAdmin
                .from('company_locations')
                .select('id', { count: 'exact', head: true })
                .eq('company_id', company.id)
                .eq('is_active', true);
            if (count) return res.status(400).json({ error: 'Choose your location first, then open ShopSafe.' });
        }

        // Individual login: that person. Shared access code: a "shop team"
        // identity that ShopSafe keeps separate from every real login.
        const user = person
            ? { id: person.id, email: person.email, name: person.name, role: person.role }
            : { id: null, shared: true, email: company.contact_email || null, name: `${company.name} team`, role: 'manager' };
        if (person && !user.email) {
            return res.status(400).json({ error: 'Your login needs an email address before ShopSafe can open.' });
        }

        const url = buildLaunchUrl({
            company: { id: company.id, name: company.name },
            location,
            user,
            distributorId: company.distributor_id || (req.distributor && req.distributor.id)
        });
        res.json({ url });
    } catch (err) {
        console.error('ShopSafe launch error:', err);
        res.status(500).json({ error: 'Could not open ShopSafe.' });
    }
});

module.exports = router;
