/**
 * routes/distributor-tax-admin.js
 *
 * A distributor's own sales-tax setup, mounted from routes/admin.js at
 *   /api/admin/distributor-tax
 *
 * The distributor picks the country it sells in (Canada or the USA), a home
 * province/state, the rate it charges there, and optionally a rate per other
 * province/state. Every client company of that distributor then picks the rate
 * up automatically (see taxSettings() in utils/tax.js). An individual client
 * can still be given its own rate, a region, or marked exempt under
 * Companies > Tax.
 *
 * Stored in distributors.settings.tax. No new table: a distributor's settings
 * were already a jsonb column, and nothing here is queried across rows.
 *
 * Super admins only: this changes what every one of the distributor's
 * customers is charged.
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requireSuperAdmin } = require('../middleware/auth');
const { invalidateDistributorCache } = require('../utils/tenant');
const { distributorTax, validateRate, DEFAULT_RATE } = require('../utils/tax');
const { COUNTRIES, isCountry, findRegion } = require('../utils/tax-regions');

const router = express.Router();
router.use(requireSuperAdmin);

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

function distributorIdOf(req) {
    return req.admin?.distributor_id || req.distributor?.id || null;
}

async function loadSettings(distributorId) {
    const { data, error } = await supabaseAdmin
        .from('distributors').select('id, name, settings').eq('id', distributorId).maybeSingle();
    if (error) throw error;
    return data;
}

/** GET / -- current setup plus the reference lists the dropdowns need. */
router.get('/', async (req, res) => {
    try {
        const id = distributorIdOf(req);
        if (!id) return res.status(400).json({ error: 'No distributor for this account.' });
        const dist = await loadSettings(id);
        if (!dist) return res.status(404).json({ error: 'Distributor not found.' });
        const cfg = distributorTax(dist.settings);
        res.json({
            distributor: { id: dist.id, name: dist.name },
            configured: !!cfg,
            country: cfg?.country || 'CA',
            region: cfg?.region || null,
            rate: cfg?.rate ?? null,
            rates: cfg?.rates || {},
            default_rate: DEFAULT_RATE,
            countries: Object.values(COUNTRIES),
            note: 'Reference rates are starting points only. Confirm your rate with your accountant; most US states also have county and city tax.'
        });
    } catch (err) {
        console.error('Distributor tax read error:', err);
        res.status(500).json({ error: 'Failed to load tax setup.' });
    }
});

/**
 * PUT /   Body: { country, region, rate?, rates? }
 *   rate   -- the rate charged in the home region (defaults to its reference rate)
 *   rates  -- { 'TX': 0.0825, ... } saved rates for other provinces/states;
 *             replaces the whole table
 */
router.put('/', async (req, res) => {
    try {
        const id = distributorIdOf(req);
        if (!id) return res.status(400).json({ error: 'No distributor for this account.' });

        const body = req.body || {};
        const country = String(body.country || '').toUpperCase();
        if (!isCountry(country)) return res.status(400).json({ error: 'Country must be Canada (CA) or the United States (US).' });

        const region = String(body.region || '').toUpperCase();
        const regionInfo = findRegion(country, region);
        if (!regionInfo) return res.status(400).json({ error: `Choose a ${COUNTRIES[country].regionLabel.toLowerCase()} from the list.` });

        let rate;
        if (body.rate === undefined || body.rate === null || body.rate === '') {
            rate = regionInfo.reference_rate;
        } else {
            const check = validateRate(body.rate);
            if (!check.ok) return res.status(400).json({ error: check.error });
            rate = check.rate;
        }

        const rates = {};
        if (body.rates !== undefined && body.rates !== null) {
            if (typeof body.rates !== 'object' || Array.isArray(body.rates)) {
                return res.status(400).json({ error: '"rates" must be an object of region code to rate.' });
            }
            for (const [rawCode, v] of Object.entries(body.rates)) {
                const code = rawCode.toUpperCase();
                if (!findRegion(country, code)) {
                    return res.status(400).json({ error: `${rawCode} is not a ${COUNTRIES[country].regionLabel.toLowerCase()} in ${COUNTRIES[country].name}.` });
                }
                const check = validateRate(v);
                if (!check.ok || check.rate === undefined) return res.status(400).json({ error: `The rate for ${code} must be a number between 0 and 1.` });
                rates[code] = check.rate;
            }
        }
        // The home region is always in the table so the whole picture is one list.
        rates[region] = rate;

        const dist = await loadSettings(id);
        if (!dist) return res.status(404).json({ error: 'Distributor not found.' });
        const settings = { ...(dist.settings || {}), tax: { country, region, rate, rates } };

        const { error } = await supabaseAdmin.from('distributors').update({ settings }).eq('id', id);
        if (error) throw error;
        invalidateDistributorCache();

        await logAction(req.admin.id, 'distributor_tax_updated', 'distributor', id, { country, region, rate, regions: Object.keys(rates) }, req.ip);

        res.json({
            message: `${dist.name} will charge ${(rate * 100).toFixed(3).replace(/\.?0+$/, '')}% tax in ${regionInfo.name} by default.`,
            country, region, rate, rates
        });
    } catch (err) {
        console.error('Distributor tax write error:', err);
        res.status(500).json({ error: 'Failed to save tax setup.' });
    }
});

module.exports = router;
