/**
 * routes/distributors-admin.js
 *
 * Platform-level distributor management, mounted from routes/admin.js at
 *   /api/admin/platform/distributors
 *
 * platform_admin only -- this is Adam's console for onboarding a second
 * distributor onto the platform, not something any distributor's own
 * super_admin (CHC included) can reach. It manages the `distributors` row
 * itself; a distributor's staff, branches, catalog and companies are all
 * created afterward through the regular /api/admin/* routes, which pick up
 * the new distributor automatically once its domain/subdomain resolves to it
 * (see utils/tenant.js).
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requirePlatformAdmin } = require('../middleware/auth');
const { stripHtml, sanitizeObject } = require('../utils/sanitize');
const { invalidateDistributorCache } = require('../utils/tenant');

const router = express.Router();

router.use(requirePlatformAdmin);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

function normalizeSlug(raw) {
    return String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-|-$/g, '');
}

function normalizeDomain(raw) {
    const d = String(raw || '').trim().toLowerCase();
    return d ? d.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null;
}

/** GET / -- every distributor on the platform. */
router.get('/', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('distributors')
            .select('id, name, slug, custom_domain, contact_email, contact_phone, is_active, is_default, stripe_connect_status, created_at')
            .order('created_at', { ascending: true });
        if (error) throw error;
        res.json({ distributors: data || [] });
    } catch (err) {
        console.error('Distributors list error:', err);
        res.status(500).json({ error: 'Failed to load distributors.' });
    }
});

/**
 * POST / -- onboard a new distributor.
 * Body: { name, slug?, custom_domain?, contact_email?, contact_phone? }
 * slug is derived from name when omitted. The new distributor starts
 * inactive-by-nothing (is_active true, is_default false) -- it becomes
 * reachable the moment its slug resolves under PLATFORM_DOMAIN, or the
 * moment its custom_domain is pointed at the app, whichever comes first.
 */
router.post('/', async (req, res) => {
    try {
        const body = sanitizeObject(req.body);
        const name = stripHtml(body.name || '').trim();
        if (!name) return res.status(400).json({ error: 'A distributor name is required.' });

        const slug = normalizeSlug(body.slug || name);
        if (!SLUG_RE.test(slug)) {
            return res.status(400).json({ error: 'That name did not produce a usable slug -- try providing one directly (lowercase letters, numbers, hyphens).' });
        }

        const customDomain = normalizeDomain(body.custom_domain);

        const { data: existingSlug } = await supabaseAdmin.from('distributors').select('id').eq('slug', slug).maybeSingle();
        if (existingSlug) return res.status(409).json({ error: 'A distributor with that slug already exists.' });

        if (customDomain) {
            const { data: existingDomain } = await supabaseAdmin.from('distributors').select('id').eq('custom_domain', customDomain).maybeSingle();
            if (existingDomain) return res.status(409).json({ error: 'That domain is already assigned to a distributor.' });
        }

        const { data: distributor, error } = await supabaseAdmin
            .from('distributors')
            .insert({
                name,
                slug,
                custom_domain: customDomain,
                contact_email: body.contact_email ? stripHtml(body.contact_email).toLowerCase() : null,
                contact_phone: body.contact_phone ? stripHtml(body.contact_phone) : null,
                is_active: true,
                is_default: false
            })
            .select('id, name, slug, custom_domain, contact_email, contact_phone, is_active, is_default, stripe_connect_status, created_at')
            .single();

        if (error) throw error;
        invalidateDistributorCache();
        res.status(201).json({ distributor });
    } catch (err) {
        console.error('Distributor create error:', err);
        res.status(500).json({ error: 'Failed to create that distributor.' });
    }
});

/**
 * PUT /:id -- update a distributor's identity/contact/active state.
 * Body: any of { name, custom_domain, contact_email, contact_phone, is_active }
 * slug and is_default are not editable here: slug is the routing key other
 * rows may already depend on, and is_default has exactly one holder,
 * changed deliberately elsewhere rather than as a side effect of an edit.
 */
router.put('/:id', async (req, res) => {
    try {
        const body = sanitizeObject(req.body);
        const updates = {};

        if (body.name !== undefined) {
            const name = stripHtml(body.name).trim();
            if (!name) return res.status(400).json({ error: 'Name cannot be blank.' });
            updates.name = name;
        }
        if (body.custom_domain !== undefined) {
            const customDomain = normalizeDomain(body.custom_domain);
            if (customDomain) {
                const { data: existingDomain } = await supabaseAdmin
                    .from('distributors').select('id').eq('custom_domain', customDomain).neq('id', req.params.id).maybeSingle();
                if (existingDomain) return res.status(409).json({ error: 'That domain is already assigned to a distributor.' });
            }
            updates.custom_domain = customDomain;
        }
        if (body.contact_email !== undefined) updates.contact_email = body.contact_email ? stripHtml(body.contact_email).toLowerCase() : null;
        if (body.contact_phone !== undefined) updates.contact_phone = body.contact_phone ? stripHtml(body.contact_phone) : null;

        if (body.is_active === false) {
            // The default distributor is the fallback every unmatched request
            // resolves to. Deactivating it would leave nothing for those
            // requests to land on (utils/tenant.js refuses rather than
            // guessing), so it can only be deactivated after another
            // distributor is made the default first.
            const { data: current } = await supabaseAdmin.from('distributors').select('is_default').eq('id', req.params.id).maybeSingle();
            if (current?.is_default) {
                return res.status(409).json({ error: 'This is the default distributor and cannot be deactivated. Make another distributor the default first.' });
            }
            updates.is_active = false;
        } else if (body.is_active === true) {
            updates.is_active = true;
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'Nothing to update.' });
        }
        updates.updated_at = new Date().toISOString();

        const { data: distributor, error } = await supabaseAdmin
            .from('distributors')
            .update(updates)
            .eq('id', req.params.id)
            .select('id, name, slug, custom_domain, contact_email, contact_phone, is_active, is_default, stripe_connect_status, created_at')
            .maybeSingle();

        if (error) throw error;
        if (!distributor) return res.status(404).json({ error: 'Distributor not found.' });
        invalidateDistributorCache();
        res.json({ distributor });
    } catch (err) {
        console.error('Distributor update error:', err);
        res.status(500).json({ error: 'Failed to update that distributor.' });
    }
});

module.exports = router;
