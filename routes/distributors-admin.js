/**
 * routes/distributors-admin.js -- the refinishAI platform console: licensing
 * the software to distributors.
 *
 * Mounted from routes/admin.js at /api/admin/platform/distributors.
 * platform_admin only -- no distributor's own staff (CHC's included) can
 * reach it.
 *
 *   GET    /                       every distributor, its licence and its usage
 *   POST   /                       onboard a distributor (identity + licence)
 *   PUT    /:id                    change identity, contact or licence terms
 *   GET    /:id/admins             its staff accounts
 *   POST   /:id/admins             invite its first (or another) super admin
 *
 * A distributor's staff, branches, catalogue and customers are then managed by
 * its own super admins in the normal admin console, on its own address (its
 * custom domain, or <slug>.PLATFORM_DOMAIN). Every licence change is written to
 * the audit log.
 */

const express = require('express');
const crypto = require('crypto');
const { supabaseAdmin } = require('../utils/supabase');
const { requirePlatformAdmin } = require('../middleware/auth');
const { stripHtml, sanitizeObject, validateEmail, isValidUUID } = require('../utils/sanitize');
const { invalidateDistributorCache, appBaseUrl } = require('../utils/tenant');
const { sendInvite } = require('../utils/email');

const router = express.Router();
router.use(requirePlatformAdmin);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const STATUSES = ['trial', 'active', 'past_due', 'suspended', 'cancelled'];
const TERMS = ['monthly', 'annual'];
const CURRENCIES = ['CAD', 'USD'];
const COUNTRIES = ['CA', 'US'];
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));

const BASE_COLS = 'id, name, slug, custom_domain, contact_email, contact_phone, is_active, is_default, stripe_connect_status, created_at';
const LICENCE_COLS = ', short_name, support_email, country, licence_plan, licence_status, licence_term, licence_fee, licence_currency, licence_started_on, licence_renews_on, trial_ends_on, max_companies, billing_contact_email, licence_notes';
const NEEDS_066 = 'Licence terms need migration 066_distributor_licensing.sql. Run it in Supabase first.';
const missingCols = err => /column|schema cache/i.test((err && err.message) || '');

function normalizeSlug(raw) {
    return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
}
function normalizeDomain(raw) {
    const d = String(raw || '').trim().toLowerCase();
    return d ? d.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '') : null;
}

async function audit(req, action, entityId, details) {
    try {
        await supabaseAdmin.from('audit_log').insert({
            admin_id: req.admin.id, action, entity_type: 'distributor', entity_id: entityId, details, ip_address: req.ip
        });
    } catch (err) { console.error('Audit log write failed:', err.message || err); }
}

/**
 * Clean the licence fields a request sent. Returns { value } (only the fields
 * present) or { error }.
 */
function licenceFields(b) {
    const v = {};
    if (b.short_name !== undefined) v.short_name = stripHtml(String(b.short_name || '')).trim().slice(0, 40) || null;
    if (b.support_email !== undefined) {
        const e = String(b.support_email || '').trim().toLowerCase();
        if (e && !validateEmail(e)) return { error: 'The support email is not a valid address.' };
        v.support_email = e || null;
    }
    if (b.billing_contact_email !== undefined) {
        const e = String(b.billing_contact_email || '').trim().toLowerCase();
        if (e && !validateEmail(e)) return { error: 'The billing email is not a valid address.' };
        v.billing_contact_email = e || null;
    }
    if (b.country !== undefined) {
        if (!COUNTRIES.includes(b.country)) return { error: 'Country must be Canada or the United States.' };
        v.country = b.country;
    }
    if (b.licence_plan !== undefined) v.licence_plan = stripHtml(String(b.licence_plan || '')).trim().slice(0, 40) || 'standard';
    if (b.licence_status !== undefined) {
        if (!STATUSES.includes(b.licence_status)) return { error: 'Choose a licence status: trial, active, past due, suspended or cancelled.' };
        v.licence_status = b.licence_status;
    }
    if (b.licence_term !== undefined) {
        if (!TERMS.includes(b.licence_term)) return { error: 'Choose monthly or annual.' };
        v.licence_term = b.licence_term;
    }
    if (b.licence_currency !== undefined) {
        if (!CURRENCIES.includes(b.licence_currency)) return { error: 'Currency must be CAD or USD.' };
        v.licence_currency = b.licence_currency;
    }
    if (b.licence_fee !== undefined) {
        const f = Number(b.licence_fee);
        if (!Number.isFinite(f) || f < 0 || f > 1e7) return { error: 'Enter a licence fee of zero or more.' };
        v.licence_fee = Math.round(f * 100) / 100;
    }
    for (const k of ['licence_started_on', 'licence_renews_on', 'trial_ends_on']) {
        if (b[k] !== undefined) {
            if (b[k] && !isDate(String(b[k]))) return { error: 'Dates must be YYYY-MM-DD.' };
            v[k] = b[k] || null;
        }
    }
    if (b.max_companies !== undefined) {
        if (b.max_companies === null || b.max_companies === '') v.max_companies = null;
        else {
            const n = Number(b.max_companies);
            if (!Number.isInteger(n) || n < 0) return { error: 'The customer limit must be a whole number, or blank for no limit.' };
            v.max_companies = n;
        }
    }
    if (b.licence_notes !== undefined) v.licence_notes = stripHtml(String(b.licence_notes || '')).slice(0, 2000) || null;
    if (v.licence_status === 'trial' && b.trial_ends_on === undefined && !v.trial_ends_on) {
        v.trial_ends_on = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    }
    return { value: v };
}

/** Customers, shops, staff and the last 30 days' orders for each distributor. */
async function usageFor(ids) {
    const out = new Map(ids.map(id => [id, { companies: 0, active_companies: 0, locations: 0, staff: 0, orders_30d: 0, dollars_30d: 0 }]));
    if (!ids.length) return out;
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    const [cos, staff] = await Promise.all([
        supabaseAdmin.from('companies').select('id, distributor_id, is_active').in('distributor_id', ids),
        supabaseAdmin.from('admin_users').select('distributor_id').in('distributor_id', ids).eq('is_active', true)
    ]);
    const companyDist = new Map();
    for (const c of cos.data || []) {
        const u = out.get(c.distributor_id); if (!u) continue;
        u.companies += 1; if (c.is_active !== false) u.active_companies += 1;
        companyDist.set(c.id, c.distributor_id);
    }
    for (const s of staff.data || []) { const u = out.get(s.distributor_id); if (u) u.staff += 1; }
    const companyIds = [...companyDist.keys()];
    for (let i = 0; i < companyIds.length; i += 200) {
        const slice = companyIds.slice(i, i + 200);
        const [locs, orders] = await Promise.all([
            supabaseAdmin.from('company_locations').select('company_id').in('company_id', slice),
            supabaseAdmin.from('orders').select('company_id, subtotal, status').in('company_id', slice).gte('created_at', since).limit(20000)
        ]);
        for (const l of locs.data || []) { const u = out.get(companyDist.get(l.company_id)); if (u) u.locations += 1; }
        for (const o of orders.data || []) {
            if (o.status === 'cancelled') continue;
            const u = out.get(companyDist.get(o.company_id)); if (!u) continue;
            u.orders_30d += 1; u.dollars_30d += Number(o.subtotal) || 0;
        }
    }
    for (const u of out.values()) u.dollars_30d = Math.round(u.dollars_30d * 100) / 100;
    return out;
}

async function selectDistributors(build) {
    let r = await build(BASE_COLS + LICENCE_COLS);
    let licence = true;
    if (r.error && missingCols(r.error)) { r = await build(BASE_COLS); licence = false; }
    return { ...r, licence };
}

/** GET / -- every distributor, its licence, its usage and its web address. */
router.get('/', async (req, res) => {
    try {
        const { data, error, licence } = await selectDistributors(cols =>
            supabaseAdmin.from('distributors').select(cols).order('created_at', { ascending: true }));
        if (error) throw error;
        const usage = await usageFor((data || []).map(d => d.id));
        res.json({
            licence_ready: licence,
            platform_domain: process.env.PLATFORM_DOMAIN || null,
            distributors: (data || []).map(d => ({ ...d, address: appBaseUrl(d), usage: usage.get(d.id) }))
        });
    } catch (err) {
        console.error('Distributors list error:', err);
        res.status(500).json({ error: 'Failed to load distributors.' });
    }
});

/**
 * POST / -- onboard a distributor.
 * Body: { name, slug?, custom_domain?, contact_email?, contact_phone?, ...licence fields }
 * Starts on a 30-day trial unless a status is given.
 */
router.post('/', async (req, res) => {
    try {
        const body = sanitizeObject(req.body || {});
        const name = stripHtml(body.name || '').trim();
        if (!name) return res.status(400).json({ error: 'A distributor name is required.' });
        const slug = normalizeSlug(body.slug || name);
        if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'That name did not produce a usable web name. Enter one: lowercase letters, numbers and hyphens.' });
        const customDomain = normalizeDomain(body.custom_domain);
        if (customDomain && !DOMAIN_RE.test(customDomain)) return res.status(400).json({ error: 'That is not a valid domain (for example orders.example.com).' });
        const contactEmail = body.contact_email ? String(body.contact_email).trim().toLowerCase() : null;
        if (contactEmail && !validateEmail(contactEmail)) return res.status(400).json({ error: 'The contact email is not a valid address.' });

        const lic = licenceFields({ licence_status: 'trial', ...body });
        if (lic.error) return res.status(400).json({ error: lic.error });

        const { data: existingSlug } = await supabaseAdmin.from('distributors').select('id').eq('slug', slug).maybeSingle();
        if (existingSlug) return res.status(409).json({ error: 'A distributor with that web name already exists.' });
        if (customDomain) {
            const { data: existingDomain } = await supabaseAdmin.from('distributors').select('id').eq('custom_domain', customDomain).maybeSingle();
            if (existingDomain) return res.status(409).json({ error: 'That domain is already assigned to a distributor.' });
        }

        const row = {
            name, slug, custom_domain: customDomain, contact_email: contactEmail,
            contact_phone: body.contact_phone ? stripHtml(body.contact_phone).slice(0, 40) : null,
            is_active: true, is_default: false,
            licence_started_on: new Date().toISOString().slice(0, 10),
            ...lic.value
        };
        let { data: distributor, error } = await supabaseAdmin.from('distributors').insert(row).select(BASE_COLS + LICENCE_COLS).single();
        if (error && missingCols(error)) return res.status(409).json({ error: NEEDS_066 });
        if (error) throw error;
        invalidateDistributorCache();
        await audit(req, 'distributor_created', distributor.id, { name, slug, custom_domain: customDomain, licence: lic.value });
        res.status(201).json({ distributor: { ...distributor, address: appBaseUrl(distributor) } });
    } catch (err) {
        console.error('Distributor create error:', err);
        res.status(500).json({ error: 'Failed to create that distributor.' });
    }
});

/** PUT /:id -- identity, contact, active state and licence terms. */
router.put('/:id', async (req, res) => {
    try {
        if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid distributor.' });
        const body = sanitizeObject(req.body || {});
        const { data: current } = await supabaseAdmin.from('distributors').select('id, is_default').eq('id', req.params.id).maybeSingle();
        if (!current) return res.status(404).json({ error: 'Distributor not found.' });

        const updates = {};
        if (body.name !== undefined) {
            const name = stripHtml(body.name).trim();
            if (!name) return res.status(400).json({ error: 'Name cannot be blank.' });
            updates.name = name;
        }
        if (body.custom_domain !== undefined) {
            const customDomain = normalizeDomain(body.custom_domain);
            if (customDomain && !DOMAIN_RE.test(customDomain)) return res.status(400).json({ error: 'That is not a valid domain.' });
            if (current.is_default && !customDomain) return res.status(409).json({ error: 'The default distributor keeps its domain.' });
            if (customDomain) {
                const { data: clash } = await supabaseAdmin.from('distributors').select('id').eq('custom_domain', customDomain).neq('id', req.params.id).maybeSingle();
                if (clash) return res.status(409).json({ error: 'That domain is already assigned to a distributor.' });
            }
            updates.custom_domain = customDomain;
        }
        if (body.contact_email !== undefined) {
            const e = body.contact_email ? String(body.contact_email).trim().toLowerCase() : null;
            if (e && !validateEmail(e)) return res.status(400).json({ error: 'The contact email is not a valid address.' });
            updates.contact_email = e;
        }
        if (body.contact_phone !== undefined) updates.contact_phone = body.contact_phone ? stripHtml(body.contact_phone).slice(0, 40) : null;
        if (body.is_active === false) {
            if (current.is_default) return res.status(409).json({ error: 'This is the default distributor and cannot be deactivated. Make another distributor the default first.' });
            updates.is_active = false;
        } else if (body.is_active === true) {
            updates.is_active = true;
        }
        const lic = licenceFields(body);
        if (lic.error) return res.status(400).json({ error: lic.error });
        if (current.is_default && lic.value.licence_status && !['active', 'past_due'].includes(lic.value.licence_status)) {
            return res.status(409).json({ error: 'The default distributor cannot be suspended, cancelled or put on trial.' });
        }
        Object.assign(updates, lic.value);
        if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update.' });
        updates.updated_at = new Date().toISOString();

        const { data: distributor, error } = await supabaseAdmin.from('distributors').update(updates)
            .eq('id', req.params.id).select(BASE_COLS + (Object.keys(lic.value).length ? LICENCE_COLS : '')).maybeSingle();
        if (error && missingCols(error)) return res.status(409).json({ error: NEEDS_066 });
        if (error) throw error;
        if (!distributor) return res.status(404).json({ error: 'Distributor not found.' });
        invalidateDistributorCache();
        await audit(req, 'distributor_updated', distributor.id, updates);
        res.json({ distributor: { ...distributor, address: appBaseUrl(distributor) } });
    } catch (err) {
        console.error('Distributor update error:', err);
        res.status(500).json({ error: 'Failed to update that distributor.' });
    }
});

/** GET /:id/admins -- the distributor's staff accounts (no password data). */
router.get('/:id/admins', async (req, res) => {
    try {
        if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid distributor.' });
        const { data, error } = await supabaseAdmin.from('admin_users')
            .select('id, email, name, role, is_active, last_login, invite_expires_at, password_hash')
            .eq('distributor_id', req.params.id).order('created_at', { ascending: true });
        if (error) throw error;
        res.json({
            admins: (data || []).map(({ password_hash, ...a }) => ({ ...a, status: password_hash ? 'active' : (a.invite_expires_at ? 'invited' : 'no password') }))
        });
    } catch (err) {
        console.error('Distributor admins error:', err);
        res.status(500).json({ error: 'Failed to load staff.' });
    }
});

/**
 * POST /:id/admins -- invite a super admin for the distributor. The invitation
 * link is on the distributor's own address (a sign-in is only accepted there),
 * so it needs a custom domain, or PLATFORM_DOMAIN set for its subdomain.
 * The link is returned too, for sending another way if email is not set up.
 */
router.post('/:id/admins', async (req, res) => {
    try {
        if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid distributor.' });
        const name = stripHtml(String((req.body || {}).name || '')).trim().slice(0, 120);
        const email = String((req.body || {}).email || '').trim().toLowerCase();
        if (!name) return res.status(400).json({ error: 'Enter the person\'s name.' });
        if (!validateEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });

        const { data: d } = await supabaseAdmin.from('distributors').select('id, name, slug, custom_domain, is_default').eq('id', req.params.id).maybeSingle();
        if (!d) return res.status(404).json({ error: 'Distributor not found.' });
        const base = appBaseUrl(d);
        if (!d.is_default && !d.custom_domain && !process.env.PLATFORM_DOMAIN) {
            return res.status(409).json({ error: 'Give this distributor its web address first: a custom domain, or set PLATFORM_DOMAIN in Railway for <name>.<platform domain>.' });
        }
        const { data: existing } = await supabaseAdmin.from('admin_users').select('id').eq('email', email).maybeSingle();
        if (existing) return res.status(409).json({ error: 'That email already has a staff account.' });

        const token = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 7 * 864e5).toISOString();
        const { data: created, error } = await supabaseAdmin.from('admin_users').insert({
            email, name, role: 'super_admin', distributor_id: d.id, branch_id: null, company_id: null,
            password_hash: null, is_active: true, invite_token: token, invite_expires_at: expires, created_by: req.admin.id
        }).select('id, email, name, role').single();
        if (error) throw error;

        const inviteUrl = `${base}/set-password.html?token=${token}&kind=admin`;
        const sent = await sendInvite({ to: email, name, context: `${d.name} on refinishAI`, invitedBy: req.admin.name, inviteUrl, expiresText: '7 days' })
            .catch(() => ({ sent: false }));
        await audit(req, 'distributor_admin_invited', d.id, { email, admin_id: created.id });
        res.status(201).json({ admin: created, email_sent: !!(sent && sent.sent), invite_url: inviteUrl, sign_in_url: `${base}/admin` });
    } catch (err) {
        console.error('Distributor admin invite error:', err);
        res.status(500).json({ error: 'Failed to invite that person.' });
    }
});

module.exports = router;
module.exports.licenceFields = licenceFields;
