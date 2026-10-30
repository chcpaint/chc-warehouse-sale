/**
 * routes/kit-submissions-store.js
 *
 * Insurance Kit Submissions, mounted from routes/storefront.js at
 *   /api/store/:slug/kit-submissions
 *
 * A shop picks a repair kit, adds the repair order and claim details, and gets a
 * numbered PDF itemizing the kit's materials to load into Mitchell / CCC ONE /
 * Audatex. Every PDF is saved against the shop and can be downloaded again.
 *
 * It deliberately does NOT touch stock. The existing kit "consume" flow draws
 * inventory down; this one only documents what a job used, so a shop that does
 * not run the Inventory module can still use it. Kits, their per-shop product
 * mapping and the "price they pay" overrides are the same data the Inventory
 * kits use (resolveKitLines), so a kit CHC has set up for a shop works here with
 * no extra setup.
 *
 * Rules carried over from the kit consume flow:
 *   - nothing is guessed: a kit line with no product match for this shop blocks
 *     generation and names the line;
 *   - a line with no price blocks it, so a document never under-states a job;
 *   - what is generated is frozen (lines_snapshot) and the row is append-only.
 *
 * The submission number comes from next_kit_submission_no() (migration 051), a
 * per-company counter incremented under a row lock, so two people generating at
 * once cannot receive the same number. A number can be skipped if a later step
 * fails, but never repeated.
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requireCompanyAuth } = require('../middleware/auth');
const { stripHtml, isValidUUID } = require('../utils/sanitize');
const { moduleSettings } = require('../utils/modules');
const { round4 } = require('../utils/inventory');
const { buildKitSubmissionPdf, loadSupplierLogo } = require('../utils/kit-submission-pdf');
const { resolveKitLines, kitsForCompany } = require('./inventory-kits');

const router = express.Router({ mergeParams: true });

router.use(requireCompanyAuth);

const MODULE = 'kit_submissions';
const SELECT_LIST = 'id, submission_no, kit_name, multiplier, ro_number, claim_no, insurer, vehicle, vin, line_count, total_amount, status, paid_at, voided_at, void_reason, location_id, created_by_name, created_at';

// ------------------------------------------------------------
// Guard: the module must be on for this company
// ------------------------------------------------------------
router.use(async (req, res, next) => {
    try {
        const { data: company, error } = await supabaseAdmin
            .from('companies')
            .select('id, name, slug, settings, distributor_id')
            .eq('id', req.company.id)
            .maybeSingle();
        if (error || !company) return res.status(404).json({ error: 'Company not found.' });

        const settings = moduleSettings(company.settings, MODULE);
        if (!settings.enabled) {
            return res.status(403).json({ error: 'Insurance kit submissions are not enabled for this account.' });
        }
        req.companyRow = company;
        req.moduleSettings = settings;
        next();
    } catch (err) {
        console.error('Kit submissions guard error:', err);
        res.status(500).json({ error: 'Failed to check this feature.' });
    }
});

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function text(v, max) {
    return stripHtml(String(v === undefined || v === null ? '' : v)).trim().slice(0, max);
}

function normalizeMultiplier(raw) {
    if (raw === undefined || raw === null || raw === '') return { ok: true, value: 1 };
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'Multiplier must be a positive number.' };
    if (n > 100) return { ok: false, error: 'Multiplier cannot exceed 100.' };
    return { ok: true, value: round4(n) };
}

/** Letters a shop will recognise: initials of a multi-word name, else its first letters. */
function prefixFor(name) {
    const words = String(name || '').replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    let p = words.length >= 2 ? words.slice(0, 4).map(w => w[0]).join('') : (words[0] || '').slice(0, 4);
    p = p.toUpperCase();
    return p.length >= 2 ? p : 'SHOP';
}

/** Price one kit for this company: resolved lines, with quantities for a multiplier. */
async function priceKit(companyId, kitId, multiplier, overrides) {
    const { lines, unresolved } = await resolveKitLines(companyId, kitId);
    const priced = [];
    for (const line of lines) {
        const o = overrides && overrides.get(line.kit_item_id);
        if (o && o.skip === true) continue;
        const qty = o && o.quantity !== undefined && o.quantity !== null && o.quantity !== ''
            ? Number(o.quantity) : round4(line.quantity * multiplier);
        priced.push({ ...line, quantity: qty });
    }
    return { priced, unresolved };
}

function blockedReason(priced, unresolved) {
    if (unresolved.length) {
        return `${unresolved.length} item${unresolved.length === 1 ? '' : 's'} in this kit ${unresolved.length === 1 ? 'is' : 'are'} not matched to your catalogue yet. CHC can map ${unresolved.length === 1 ? 'it' : 'them'} for you.`;
    }
    if (priced.length === 0) return 'This kit has no usable lines.';
    const unpriced = priced.find(l => !(Number(l.unit_price) > 0));
    if (unpriced) return `${unpriced.sku || unpriced.name} has no price — the document would under-state the job. CHC can set it.`;
    return null;
}

function parseOverrides(body, allowed) {
    const map = new Map();
    if (!allowed || !Array.isArray(body && body.lines)) return map;
    for (const raw of body.lines.slice(0, 200)) {
        if (raw && isValidUUID(raw.kit_item_id)) map.set(raw.kit_item_id, raw);
    }
    return map;
}

async function loadDistributor(distributorId) {
    if (!distributorId) return null;
    const { data } = await supabaseAdmin
        .from('distributors')
        .select('id, name, slug, logo_url, is_default, contact_phone, contact_email')
        .eq('id', distributorId)
        .maybeSingle();
    return data || null;
}

// ------------------------------------------------------------
// Kits this shop can submit
// ------------------------------------------------------------
router.get('/kits', async (req, res) => {
    try {
        const kits = await kitsForCompany(req.company.id);
        const out = [];
        for (const kit of kits) {
            const { priced, unresolved } = await priceKit(req.company.id, kit.id, 1, null);
            out.push({
                id: kit.id,
                name: kit.name,
                description: kit.description || null,
                line_count: priced.length,
                unresolved_count: unresolved.length,
                ready: !blockedReason(priced, unresolved),
                estimated_total: round4(priced.reduce((s, l) => s + l.quantity * l.unit_price, 0))
            });
        }
        res.json({ kits: out, allow_line_overrides: req.moduleSettings.allow_line_overrides !== false });
    } catch (err) {
        console.error('Kit submission kit list error:', err);
        res.status(500).json({ error: 'Failed to load kits.' });
    }
});

router.get('/kits/:kitId/preview', async (req, res) => {
    try {
        const kitId = req.params.kitId;
        if (!isValidUUID(kitId)) return res.status(400).json({ error: 'Invalid kit.' });
        const kits = await kitsForCompany(req.company.id);
        const kit = kits.find(k => k.id === kitId);
        if (!kit) return res.status(404).json({ error: 'Kit not found for this account.' });

        const multiplier = normalizeMultiplier(req.query.multiplier);
        if (!multiplier.ok) return res.status(400).json({ error: multiplier.error });

        const { priced, unresolved } = await priceKit(req.company.id, kit.id, multiplier.value, null);
        const lines = priced.map(l => ({
            kit_item_id: l.kit_item_id, sku: l.sku, brand: l.brand, name: l.name, unit: l.unit,
            quantity: l.quantity, unit_price: l.unit_price, line_cost: round4(l.quantity * l.unit_price),
            unpriced: !(Number(l.unit_price) > 0)
        }));
        const reason = blockedReason(priced, unresolved);
        res.json({
            kit: { id: kit.id, name: kit.name, description: kit.description || null },
            multiplier: multiplier.value,
            lines, unresolved,
            total: round4(lines.reduce((s, l) => s + l.line_cost, 0)),
            blocked: !!reason, blocked_reason: reason,
            allow_line_overrides: req.moduleSettings.allow_line_overrides !== false
        });
    } catch (err) {
        console.error('Kit submission preview error:', err);
        res.status(500).json({ error: 'Failed to preview that kit.' });
    }
});

// ------------------------------------------------------------
// Generate (create + number + freeze)
// ------------------------------------------------------------
router.post('/', async (req, res) => {
    try {
        const body = req.body || {};
        const companyId = req.company.id;

        const kitId = body.kit_id;
        if (!isValidUUID(kitId)) return res.status(400).json({ error: 'Choose a kit.' });
        const kits = await kitsForCompany(companyId);
        const kit = kits.find(k => k.id === kitId);
        if (!kit) return res.status(404).json({ error: 'Kit not found for this account.' });

        const roNumber = text(body.ro_number, 60);
        if (!roNumber) return res.status(400).json({ error: 'A repair order number is required.' });

        const actor = (req.companyUser && req.companyUser.name) || text(body.actor_label, 80);
        if (!actor) return res.status(400).json({ error: 'Enter your name so the document can show who prepared it.' });

        const vin = text(body.vin, 20).toUpperCase().replace(/\s+/g, '');
        if (vin && !/^[A-Z0-9]{5,20}$/.test(vin)) return res.status(400).json({ error: 'That VIN does not look right. Letters and numbers only.' });

        const multiplier = normalizeMultiplier(body.multiplier);
        if (!multiplier.ok) return res.status(400).json({ error: multiplier.error });

        let locationId = null;
        if (body.location_id) {
            if (!isValidUUID(body.location_id)) return res.status(400).json({ error: 'Invalid location.' });
            const { data: loc } = await supabaseAdmin
                .from('company_locations').select('id').eq('id', body.location_id).eq('company_id', companyId).maybeSingle();
            if (!loc) return res.status(400).json({ error: 'That location is not part of this account.' });
            locationId = loc.id;
        } else if (req.companyUser && req.companyUser.location_id) {
            locationId = req.companyUser.location_id;
        }

        const overrides = parseOverrides(body, req.moduleSettings.allow_line_overrides !== false);
        const { priced, unresolved } = await priceKit(companyId, kit.id, multiplier.value, overrides);

        const reason = blockedReason(priced, unresolved);
        if (reason) return res.status(409).json({ error: reason, unresolved });

        for (const l of priced) {
            if (!Number.isFinite(l.quantity) || l.quantity <= 0) {
                return res.status(400).json({ error: `Quantity for ${l.sku || l.name} must be a positive number.` });
            }
            if (l.quantity > 100000) return res.status(400).json({ error: `Quantity for ${l.sku || l.name} is out of range.` });
        }
        if (priced.length === 0) return res.status(400).json({ error: 'Every line was removed — nothing to submit.' });

        const lines = priced.map(l => ({
            kit_sku: l.kit_sku, sku: l.sku, brand: l.brand || null, name: l.name,
            category: l.category || null, unit: l.unit, quantity: round4(l.quantity),
            unit_price: l.unit_price, line_cost: round4(round4(l.quantity) * l.unit_price)
        }));
        const total = Math.round(lines.reduce((s, l) => s + l.line_cost, 0) * 100) / 100;

        const row = {
            company_id: companyId,
            location_id: locationId,
            kit_id: kit.id,
            kit_name: kit.name,
            multiplier: multiplier.value,
            ro_number: roNumber,
            claim_no: text(body.claim_no, 60) || null,
            insurer: text(body.insurer, 120) || null,
            vehicle: text(body.vehicle, 160) || null,
            vin: vin || null,
            notes: text(body.notes, 1000) || null,
            line_count: lines.length,
            total_amount: total,
            lines_snapshot: lines,
            created_by_name: actor,
            created_by_user_id: req.companyUser ? req.companyUser.id : null
        };

        // The number comes from the database counter; on the (very unlikely)
        // event the insert still collides, take the next one rather than fail.
        let created = null;
        for (let attempt = 0; attempt < 3 && !created; attempt++) {
            const { data: no, error: noErr } = await supabaseAdmin.rpc('next_kit_submission_no', {
                p_company: companyId, p_prefix: prefixFor(req.companyRow.name)
            });
            if (noErr || !no) throw noErr || new Error('No submission number returned.');

            const { data, error } = await supabaseAdmin
                .from('kit_submissions')
                .insert({ ...row, submission_no: no })
                .select(SELECT_LIST)
                .single();
            if (!error) { created = data; break; }
            if (error.code !== '23505') throw error;
        }
        if (!created) throw new Error('Could not allocate a unique submission number.');

        res.status(201).json({
            message: `Submission ${created.submission_no} created.`,
            submission: created
        });
    } catch (err) {
        console.error('Kit submission create error:', err);
        res.status(500).json({ error: 'Failed to create that submission. Nothing was saved.' });
    }
});

// ------------------------------------------------------------
// Saved submissions
// ------------------------------------------------------------
router.get('/', async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

        let query = supabaseAdmin
            .from('kit_submissions')
            .select(SELECT_LIST, { count: 'exact' })
            .eq('company_id', req.company.id)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        const status = text(req.query.status, 10);
        if (['issued', 'paid', 'void'].includes(status)) query = query.eq('status', status);

        const q = text(req.query.q, 60).replace(/[%,()*]/g, '');
        if (q) query = query.or(`submission_no.ilike.%${q}%,ro_number.ilike.%${q}%,claim_no.ilike.%${q}%,insurer.ilike.%${q}%,kit_name.ilike.%${q}%`);

        const { data, error, count } = await query;
        if (error) throw error;
        res.json({ submissions: data || [], total: count || 0 });
    } catch (err) {
        console.error('Kit submission list error:', err);
        res.status(500).json({ error: 'Failed to load saved submissions.' });
    }
});

async function loadOwn(req, res) {
    if (!isValidUUID(req.params.id)) { res.status(400).json({ error: 'Invalid submission.' }); return null; }
    const { data } = await supabaseAdmin
        .from('kit_submissions')
        .select('*')
        .eq('id', req.params.id)
        .eq('company_id', req.company.id)
        .maybeSingle();
    if (!data) { res.status(404).json({ error: 'Submission not found.' }); return null; }
    return data;
}

router.get('/:id', async (req, res) => {
    try {
        const sub = await loadOwn(req, res);
        if (!sub) return;
        res.json({ submission: sub });
    } catch (err) {
        console.error('Kit submission detail error:', err);
        res.status(500).json({ error: 'Failed to load that submission.' });
    }
});

router.get('/:id/pdf', async (req, res) => {
    try {
        const sub = await loadOwn(req, res);
        if (!sub) return;

        const distributor = await loadDistributor(req.companyRow.distributor_id);
        let location = null;
        if (sub.location_id) {
            const { data } = await supabaseAdmin
                .from('company_locations').select('name, city').eq('id', sub.location_id).eq('company_id', req.company.id).maybeSingle();
            location = data || null;
        }
        const logo = await loadSupplierLogo(distributor);
        const pdf = await buildKitSubmissionPdf({
            submission: sub, company: { name: req.companyRow.name }, location, distributor, logo
        });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${sub.submission_no}.pdf"`);
        res.setHeader('Cache-Control', 'private, no-store');
        res.send(pdf);
    } catch (err) {
        console.error('Kit submission PDF error:', err);
        res.status(500).json({ error: 'Failed to build that PDF.' });
    }
});

/**
 * PATCH /:id   Body: { status: 'issued'|'paid'|'void', void_reason? }
 * The document itself is frozen; only where it stands moves. A voided
 * submission is final and keeps its number.
 */
router.patch('/:id', async (req, res) => {
    try {
        const sub = await loadOwn(req, res);
        if (!sub) return;

        const next = text(req.body && req.body.status, 10);
        if (!['issued', 'paid', 'void'].includes(next)) return res.status(400).json({ error: 'Status must be issued, paid or void.' });
        if (sub.status === 'void') return res.status(409).json({ error: 'A voided submission cannot be changed. Generate a new one.' });
        if (sub.status === next) return res.json({ submission: sub });

        const patch = { status: next };
        if (next === 'paid') { patch.paid_at = new Date().toISOString(); }
        if (next === 'issued') { patch.paid_at = null; }
        if (next === 'void') {
            const why = text(req.body.void_reason, 300);
            if (!why) return res.status(400).json({ error: 'Say why this is being voided.' });
            patch.void_reason = why;
            patch.voided_at = new Date().toISOString();
        }

        const { data, error } = await supabaseAdmin
            .from('kit_submissions').update(patch)
            .eq('id', sub.id).eq('company_id', req.company.id)
            .select(SELECT_LIST).single();
        if (error) throw error;
        res.json({ submission: data });
    } catch (err) {
        console.error('Kit submission status error:', err);
        res.status(500).json({ error: 'Failed to update that submission.' });
    }
});

module.exports = router;
module.exports.prefixFor = prefixFor;
