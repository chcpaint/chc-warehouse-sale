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
const { moduleSettings, moduleEnabled } = require('../utils/modules');
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
        // A shop that does not run inventory has no kit mapping to maintain: its kits read straight
        // from the master kit. (settings.kit_submissions.require_mapping = true opts back in.)
        req.autoMapping = !moduleEnabled(company.settings, 'inventory') && settings.require_mapping !== true;
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
async function priceKit(companyId, kitId, multiplier, overrides, auto) {
    const { lines, unresolved } = await resolveKitLines(companyId, kitId, { auto: auto === true });
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

function blockedReason(priced, unresolved, auto) {
    if (unresolved.length && auto) {
        const first = unresolved[0];
        return `${first.sku || 'A part'} is not in the CHC item library yet, so it has no name or price${unresolved.length > 1 ? ` (and ${unresolved.length - 1} more)` : ''}. CHC can add it.`;
    }
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
            const { priced, unresolved } = await priceKit(req.company.id, kit.id, 1, null, req.autoMapping);
            out.push({
                id: kit.id,
                name: kit.name,
                description: kit.description || null,
                own: kit.company_id === req.company.id,
                line_count: priced.length,
                unresolved_count: unresolved.length,
                ready: !blockedReason(priced, unresolved, req.autoMapping),
                estimated_total: round4(priced.reduce((s, l) => s + l.quantity * l.unit_price, 0))
            });
        }
        res.json({
            kits: out,
            allow_line_overrides: req.moduleSettings.allow_line_overrides !== false,
            allow_add_kit: req.moduleSettings.allow_add_kit !== false,
            allow_edit_kits: req.moduleSettings.allow_edit_kits === true
        });
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

        const { priced, unresolved } = await priceKit(req.company.id, kit.id, multiplier.value, null, req.autoMapping);
        const lines = priced.map(l => ({
            kit_item_id: l.kit_item_id, sku: l.sku, brand: l.brand, name: l.name, unit: l.unit,
            quantity: l.quantity, unit_price: l.unit_price, line_cost: round4(l.quantity * l.unit_price),
            unpriced: !(Number(l.unit_price) > 0)
        }));
        const reason = blockedReason(priced, unresolved, req.autoMapping);
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
// Add Kit: a shop builds its own kit
//
// A shop can assemble a kit from parts it can already order (its catalogue)
// and, when it does not run inventory, from the CHC item library. The kit is
// private to the shop (company_id set, source 'company') and appears in its kit
// list straight away. Off per shop with settings.kit_submissions.allow_add_kit
// = false. CHC master kits are never touched from here.
// ------------------------------------------------------------
const skuKeyOf = v => String(v == null ? '' : v).replace(/[^A-Za-z0-9]/g, '').toUpperCase();

function addKitAllowed(req, res) {
    if (req.moduleSettings.allow_add_kit === false) {
        res.status(403).json({ error: 'Adding kits is not turned on for your shop. Ask CHC.' });
        return false;
    }
    return true;
}

function editKitAllowed(req, res) {
    if (req.moduleSettings.allow_edit_kits !== true) {
        res.status(403).json({ error: 'Editing kits is not turned on for your shop. Ask CHC.' });
        return false;
    }
    return true;
}

/** GET /parts?q=  -- part numbers / names this shop can put in a kit. */
router.get('/parts', async (req, res) => {
    try {
        if (req.moduleSettings.allow_add_kit === false && req.moduleSettings.allow_edit_kits !== true) {
            return res.status(403).json({ error: 'Adding kits is not turned on for your shop. Ask CHC.' });
        }
        const q = String(req.query.q || '').replace(/[^A-Za-z0-9 .\-\/#]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
        if (q.length < 2) return res.json({ parts: [] });
        const qKey = skuKeyOf(q);

        const own = await supabaseAdmin.from('products')
            .select('id, sku, name, brand, unit')
            .eq('company_id', req.company.id).eq('is_active', true)
            .or(`sku.ilike.%${q}%,name.ilike.%${q}%`)
            .order('sku').limit(12);
        if (own.error) throw own.error;

        const parts = [];
        const seen = new Set();
        for (const p of own.data || []) {
            const k = skuKeyOf(p.sku);
            if (!k || seen.has(k)) continue;
            seen.add(k);
            parts.push({ sku: p.sku, name: p.name, brand: p.brand || null, unit: p.unit || 'each', source: 'catalogue' });
        }

        if (req.autoMapping) {
            let filter = `sku.ilike.%${q}%,name.ilike.%${q}%`;
            if (qKey) filter += `,sku_key.ilike.%${qKey}%`;
            const lib = await supabaseAdmin.from('item_library')
                .select('sku, name, brand, unit').or(filter).order('sku').limit(12);
            if (lib.error) throw lib.error;
            for (const p of lib.data || []) {
                const k = skuKeyOf(p.sku);
                if (!k || seen.has(k)) continue;
                seen.add(k);
                parts.push({ sku: p.sku, name: p.name, brand: p.brand || null, unit: p.unit || 'each', source: 'library' });
            }
        }
        res.json({ parts: parts.slice(0, 20) });
    } catch (err) {
        console.error('Kit part search error:', err);
        res.status(500).json({ error: 'Could not search parts.' });
    }
});

/**
 * POST /my-kits   Body: { name, description, lines: [{ sku, quantity, unit }] }
 * Every part number must be one this shop can use; nothing is invented.
 */
router.post('/my-kits', async (req, res) => {
    let kitId = null;
    try {
        if (!addKitAllowed(req, res)) return;
        const companyId = req.company.id;

        const name = text(req.body && req.body.name, 120);
        if (!name) return res.status(400).json({ error: 'Give the kit a name.' });
        const raw = Array.isArray(req.body && req.body.lines) ? req.body.lines : [];
        if (raw.length === 0) return res.status(400).json({ error: 'Add at least one part to the kit.' });
        if (raw.length > 200) return res.status(400).json({ error: 'A kit can hold up to 200 parts.' });

        const { data: existing } = await supabaseAdmin.from('repair_kits')
            .select('id, name').eq('company_id', companyId).eq('is_active', true);
        if ((existing || []).some(k => String(k.name).trim().toLowerCase() === name.toLowerCase())) {
            return res.status(409).json({ error: `You already have a kit called "${name}". Choose a different name.` });
        }

        const wanted = [];
        const seen = new Set();
        for (const [i, l] of raw.entries()) {
            const sku = text(l && l.sku, 80);
            const key = skuKeyOf(sku);
            if (!key) return res.status(400).json({ error: `Line ${i + 1}: choose a part.` });
            if (seen.has(key)) return res.status(400).json({ error: `Line ${i + 1}: ${sku} is listed twice. Change its quantity instead.` });
            seen.add(key);
            const quantity = Number(l && l.quantity);
            if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) {
                return res.status(400).json({ error: `Line ${i + 1}: quantity must be a number above zero.` });
            }
            wanted.push({ sku, key, quantity, unit: text(l && l.unit, 20) || 'each' });
        }

        const { data: prods, error: pErr } = await supabaseAdmin.from('products')
            .select('id, sku, unit, is_active').eq('company_id', companyId)
            .in('sku', wanted.map(w => w.sku));
        if (pErr) throw pErr;
        const prodByKey = new Map();
        for (const p of prods || []) if (p.is_active !== false) prodByKey.set(skuKeyOf(p.sku), p);

        let libByKey = new Map();
        if (req.autoMapping) {
            const missing = wanted.filter(w => !prodByKey.has(w.key)).map(w => w.key);
            if (missing.length) {
                const { data: lib, error: lErr } = await supabaseAdmin.from('item_library')
                    .select('sku, sku_key, unit').in('sku_key', missing);
                if (lErr) throw lErr;
                libByKey = new Map((lib || []).map(r => [r.sku_key, r]));
            }
        }

        const lines = [];
        for (const [i, w] of wanted.entries()) {
            const p = prodByKey.get(w.key);
            const lib = libByKey.get(w.key);
            if (!p && !lib) {
                return res.status(400).json({ error: `Line ${i + 1}: ${w.sku} is not a part your shop can use. Pick it from the search results.` });
            }
            lines.push({
                sku: p ? p.sku : lib.sku,
                product_id: p ? p.id : null,
                quantity: w.quantity,
                unit: w.unit,
                sort_order: i + 1
            });
        }

        const { data: kit, error: kErr } = await supabaseAdmin.from('repair_kits')
            .insert({
                company_id: companyId, name,
                description: text(req.body && req.body.description, 500) || null,
                source: 'company', is_active: true, sort_order: 900
            }).select('id, name').single();
        if (kErr) throw kErr;
        kitId = kit.id;

        const { error: iErr } = await supabaseAdmin.from('kit_items').insert(lines.map(l => ({ ...l, kit_id: kit.id })));
        if (iErr) throw iErr;

        res.status(201).json({ kit: { id: kit.id, name: kit.name, line_count: lines.length } });
    } catch (err) {
        console.error('Add kit error:', err);
        if (kitId) { try { await supabaseAdmin.from('repair_kits').delete().eq('id', kitId); } catch (_) { /* noop */ } }
        res.status(500).json({ error: 'Could not save that kit.' });
    }
});

/** DELETE /my-kits/:kitId -- retire one of the shop's own kits. Saved submissions keep their own copy. */
router.delete('/my-kits/:kitId', async (req, res) => {
    try {
        if (!addKitAllowed(req, res)) return;
        const kitId = req.params.kitId;
        if (!isValidUUID(kitId)) return res.status(400).json({ error: 'Invalid kit.' });
        const { data: kit } = await supabaseAdmin.from('repair_kits')
            .select('id, name, company_id').eq('id', kitId).maybeSingle();
        if (!kit || kit.company_id !== req.company.id) return res.status(404).json({ error: 'Kit not found.' });
        const { error } = await supabaseAdmin.from('repair_kits').update({ is_active: false }).eq('id', kitId);
        if (error) throw error;
        res.json({ message: `${kit.name} removed. Past submissions keep their record.` });
    } catch (err) {
        console.error('Remove kit error:', err);
        res.status(500).json({ error: 'Could not remove that kit.' });
    }
});

// ------------------------------------------------------------
// Edit Kits: change a shop's own kit (parts, quantities, prices)
//
// Only where CHC has switched it on for the shop
// (settings.kit_submissions.allow_edit_kits = true). A CHC master kit is shared
// by every shop and is never edited: the shop first takes its own copy
// ("customize"), then edits that. A price set here is stored per shop against
// the kit line (kit_product_map.unit_price_override); clearing it returns the
// line to the catalogue / library price.
// ------------------------------------------------------------
const MAX_PRICE = 1000000;

function validPrice(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= MAX_PRICE ? Math.round(n * 10000) / 10000 : null;
}

async function ownKit(req, kitId) {
    if (!isValidUUID(kitId)) return null;
    const { data: kit } = await supabaseAdmin.from('repair_kits')
        .select('id, name, description, company_id, is_active').eq('id', kitId).maybeSingle();
    return kit && kit.company_id === req.company.id && kit.is_active !== false ? kit : null;
}

/** GET /my-kits/:kitId  -- the kit as an editor needs it: every line, priced. */
router.get('/my-kits/:kitId', async (req, res) => {
    try {
        if (!editKitAllowed(req, res)) return;
        const kit = await ownKit(req, req.params.kitId);
        if (!kit) return res.status(404).json({ error: 'Kit not found. Only your own kits can be edited.' });

        const { lines, unresolved } = await resolveKitLines(req.company.id, kit.id, { auto: req.autoMapping });
        const { data: items } = await supabaseAdmin.from('kit_items')
            .select('id, sku, quantity, unit, sort_order').eq('kit_id', kit.id).order('sort_order', { ascending: true });
        const byId = new Map(lines.map(l => [l.kit_item_id, l]));
        const badById = new Map(unresolved.map(u => [u.kit_item_id, u]));

        const out = (items || []).map(i => {
            const l = byId.get(i.id);
            if (l) {
                return {
                    kit_item_id: i.id, sku: l.sku, name: l.name, brand: l.brand, unit: i.unit || 'each',
                    quantity: Number(i.quantity), unit_price: l.unit_price, catalogue_price: l.catalogue_unit_price,
                    price_overridden: !!l.price_overridden, problem: null
                };
            }
            const u = badById.get(i.id);
            return {
                kit_item_id: i.id, sku: i.sku, name: null, brand: null, unit: i.unit || 'each',
                quantity: Number(i.quantity), unit_price: null, catalogue_price: null,
                price_overridden: false, problem: (u && u.reason) || 'This part cannot be priced.'
            };
        });
        res.json({ kit: { id: kit.id, name: kit.name, description: kit.description || '' }, lines: out });
    } catch (err) {
        console.error('Load kit for edit error:', err);
        res.status(500).json({ error: 'Could not load that kit.' });
    }
});

/**
 * PUT /my-kits/:kitId
 * Body: { name, description, lines: [{ kit_item_id?, sku, quantity, unit, unit_price? }] }
 *   kit_item_id present  -> an existing line (part number is fixed; quantity / unit / price may change)
 *   kit_item_id absent   -> a new part, checked like Add Kit
 *   a line left out      -> removed
 *   unit_price omitted   -> price left as it is;  null -> back to the catalogue price;  number -> that price
 */
router.put('/my-kits/:kitId', async (req, res) => {
    try {
        if (!editKitAllowed(req, res)) return;
        const companyId = req.company.id;
        const kit = await ownKit(req, req.params.kitId);
        if (!kit) return res.status(404).json({ error: 'Kit not found. Only your own kits can be edited.' });

        const name = text(req.body && req.body.name, 120);
        if (!name) return res.status(400).json({ error: 'Give the kit a name.' });
        const raw = Array.isArray(req.body && req.body.lines) ? req.body.lines : [];
        if (raw.length === 0) return res.status(400).json({ error: 'A kit needs at least one part. Remove the whole kit instead if you no longer use it.' });
        if (raw.length > 200) return res.status(400).json({ error: 'A kit can hold up to 200 parts.' });

        const { data: others } = await supabaseAdmin.from('repair_kits')
            .select('id, name').eq('company_id', companyId).eq('is_active', true);
        if ((others || []).some(k => k.id !== kit.id && String(k.name).trim().toLowerCase() === name.toLowerCase())) {
            return res.status(409).json({ error: `You already have a kit called "${name}". Choose a different name.` });
        }

        const { data: existingItems, error: eErr } = await supabaseAdmin.from('kit_items')
            .select('id, sku, product_id, quantity, unit').eq('kit_id', kit.id);
        if (eErr) throw eErr;
        const existingById = new Map((existingItems || []).map(i => [i.id, i]));

        // ---- validate everything before changing anything
        const keep = [];       // existing lines: { item, quantity, unit, price }
        const added = [];      // new lines:      { sku, key, quantity, unit }
        const seen = new Set();
        for (const [i, l] of raw.entries()) {
            const n = i + 1;
            const quantity = Number(l && l.quantity);
            if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) {
                return res.status(400).json({ error: `Line ${n}: quantity must be a number above zero.` });
            }
            const unit = text(l && l.unit, 20) || 'each';
            let price;                                     // undefined = leave, null = clear, number = set
            if (l && Object.prototype.hasOwnProperty.call(l, 'unit_price')) {
                if (l.unit_price === null || l.unit_price === '') price = null;
                else {
                    price = validPrice(l.unit_price);
                    if (price === null) return res.status(400).json({ error: `Line ${n}: the price must be a number, zero or more.` });
                }
            }
            if (l && l.kit_item_id) {
                const item = existingById.get(l.kit_item_id);
                if (!item) return res.status(400).json({ error: `Line ${n}: that part is not in this kit.` });
                const key = skuKeyOf(item.sku);
                if (seen.has(key)) return res.status(400).json({ error: `Line ${n}: ${item.sku} is listed twice.` });
                seen.add(key);
                keep.push({ item, quantity, unit, price });
            } else {
                const sku = text(l && l.sku, 80);
                const key = skuKeyOf(sku);
                if (!key) return res.status(400).json({ error: `Line ${n}: choose a part.` });
                if (seen.has(key)) return res.status(400).json({ error: `Line ${n}: ${sku} is listed twice. Change its quantity instead.` });
                seen.add(key);
                added.push({ sku, key, quantity, unit, price });
            }
        }

        // new parts must be ones this shop can use
        let resolvedNew = [];
        if (added.length) {
            const { data: prods, error: pErr } = await supabaseAdmin.from('products')
                .select('id, sku, is_active').eq('company_id', companyId).in('sku', added.map(a => a.sku));
            if (pErr) throw pErr;
            const prodByKey = new Map();
            for (const p of prods || []) if (p.is_active !== false) prodByKey.set(skuKeyOf(p.sku), p);
            let libByKey = new Map();
            if (req.autoMapping) {
                const missing = added.filter(a => !prodByKey.has(a.key)).map(a => a.key);
                if (missing.length) {
                    const { data: lib, error: lErr } = await supabaseAdmin.from('item_library').select('sku, sku_key').in('sku_key', missing);
                    if (lErr) throw lErr;
                    libByKey = new Map((lib || []).map(r => [r.sku_key, r]));
                }
            }
            for (const a of added) {
                const p = prodByKey.get(a.key), lib = libByKey.get(a.key);
                if (!p && !lib) return res.status(400).json({ error: `${a.sku} is not a part your shop can use. Pick it from the search results.` });
                resolvedNew.push({ ...a, sku: p ? p.sku : lib.sku, product_id: p ? p.id : null });
            }
        }

        // ---- apply
        const { error: kErr } = await supabaseAdmin.from('repair_kits')
            .update({ name, description: text(req.body && req.body.description, 500) || null }).eq('id', kit.id);
        if (kErr) throw kErr;

        const keptIds = new Set(keep.map(k => k.item.id));
        const removeIds = (existingItems || []).filter(i => !keptIds.has(i.id)).map(i => i.id);
        if (removeIds.length) {
            const { error } = await supabaseAdmin.from('kit_items').delete().in('id', removeIds).eq('kit_id', kit.id);
            if (error) throw error;
        }

        let order = 0;
        const priceWrites = [];                            // { item_id, product_id, price }
        // keep the order the person arranged them in
        for (const [i, l] of raw.entries()) {
            order = i + 1;
            if (l && l.kit_item_id) {
                const k = keep.find(x => x.item.id === l.kit_item_id);
                const { error } = await supabaseAdmin.from('kit_items')
                    .update({ quantity: k.quantity, unit: k.unit, sort_order: order }).eq('id', k.item.id);
                if (error) throw error;
                if (k.price !== undefined) priceWrites.push({ item_id: k.item.id, product_id: k.item.product_id || null, price: k.price });
            }
        }
        for (const a of resolvedNew) {
            const position = raw.findIndex(l => !l.kit_item_id && skuKeyOf(l.sku) === a.key) + 1;
            const { data: row, error } = await supabaseAdmin.from('kit_items')
                .insert({ kit_id: kit.id, sku: a.sku, product_id: a.product_id, quantity: a.quantity, unit: a.unit, sort_order: position || ++order })
                .select('id').single();
            if (error) throw error;
            if (a.price !== undefined && a.price !== null) priceWrites.push({ item_id: row.id, product_id: a.product_id, price: a.price });
        }

        for (const w of priceWrites) {
            const { data: existing } = await supabaseAdmin.from('kit_product_map')
                .select('id').eq('company_id', companyId).eq('kit_item_id', w.item_id).maybeSingle();
            if (existing) {
                const { error } = await supabaseAdmin.from('kit_product_map')
                    .update({ unit_price_override: w.price }).eq('id', existing.id);
                if (error) throw error;
            } else if (w.price !== null) {
                // product_id carries the line's own product so the line keeps resolving
                const { error } = await supabaseAdmin.from('kit_product_map')
                    .insert({ company_id: companyId, kit_item_id: w.item_id, product_id: w.product_id, is_excluded: false, unit_price_override: w.price });
                if (error) throw error;
            }
        }

        res.json({ message: `${name} saved.`, kit: { id: kit.id, name, line_count: raw.length } });
    } catch (err) {
        console.error('Edit kit error:', err);
        res.status(500).json({ error: 'Could not save that kit. Reload it to see what was saved.' });
    }
});

/**
 * POST /kits/:kitId/customize   Body: { name?, hide_original? }
 * Take a copy of a CHC kit that belongs to this shop, carrying across anything
 * already changed for it (quantities, dropped lines, prices), so it can be
 * edited freely. By default the CHC original is hidden from the shop's list so
 * there is one version of it, not two.
 */
router.post('/kits/:kitId/customize', async (req, res) => {
    let newId = null;
    try {
        if (!editKitAllowed(req, res)) return;
        const companyId = req.company.id;
        const kits = await kitsForCompany(companyId);
        const master = kits.find(k => k.id === req.params.kitId);
        if (!master || master.company_id !== null) return res.status(404).json({ error: 'That CHC kit is not available to copy.' });

        const { data: existing } = await supabaseAdmin.from('repair_kits')
            .select('id, name').eq('company_id', companyId).eq('is_active', true);
        const taken = new Set((existing || []).map(k => String(k.name).trim().toLowerCase()));
        let name = text(req.body && req.body.name, 120) || `${master.name} (my copy)`;
        if (taken.has(name.toLowerCase())) return res.status(409).json({ error: `You already have a kit called "${name}". Choose a different name.` });

        const { data: items, error: iErr } = await supabaseAdmin.from('kit_items')
            .select('id, sku, product_id, quantity, unit, sort_order').eq('kit_id', master.id).order('sort_order', { ascending: true });
        if (iErr) throw iErr;
        const { data: maps } = await supabaseAdmin.from('kit_product_map')
            .select('kit_item_id, product_id, quantity, is_excluded, unit_price_override')
            .eq('company_id', companyId).in('kit_item_id', (items || []).map(i => i.id));
        const mapBy = new Map((maps || []).map(m => [m.kit_item_id, m]));

        // The shop's own catalogue, so each copied line links to its own product when it has one
        const skus = [...new Set((items || []).map(i => i.sku).filter(Boolean))];
        const { data: prods } = skus.length ? await supabaseAdmin.from('products')
            .select('id, sku, is_active').eq('company_id', companyId).in('sku', skus) : { data: [] };
        const prodByKey = new Map();
        for (const p of prods || []) if (p.is_active !== false) prodByKey.set(skuKeyOf(p.sku), p);

        const copies = [];
        for (const i of items || []) {
            const m = mapBy.get(i.id);
            if (m && m.is_excluded) continue;                         // a line this shop already dropped
            const qty = Number(m && m.quantity != null ? m.quantity : i.quantity);
            if (!Number.isFinite(qty) || qty <= 0) continue;
            const p = prodByKey.get(skuKeyOf(i.sku));
            copies.push({ src: i, sku: i.sku, product_id: (m && m.product_id) || i.product_id || (p ? p.id : null), quantity: qty, unit: i.unit || 'each',
                          price: m && m.unit_price_override != null ? Number(m.unit_price_override) : null });
        }
        if (!copies.length) return res.status(400).json({ error: 'That kit has no lines to copy.' });

        const { data: kit, error: kErr } = await supabaseAdmin.from('repair_kits')
            .insert({ company_id: companyId, name, description: master.description || null, source: 'company', is_active: true, sort_order: 900 })
            .select('id, name').single();
        if (kErr) throw kErr;
        newId = kit.id;

        for (const [idx, c] of copies.entries()) {
            const { data: row, error } = await supabaseAdmin.from('kit_items')
                .insert({ kit_id: kit.id, sku: c.sku, product_id: c.product_id, quantity: c.quantity, unit: c.unit, sort_order: idx + 1 })
                .select('id').single();
            if (error) throw error;
            if (c.price !== null) {
                const { error: mErr } = await supabaseAdmin.from('kit_product_map')
                    .insert({ company_id: companyId, kit_item_id: row.id, product_id: c.product_id, is_excluded: false, unit_price_override: c.price });
                if (mErr) throw mErr;
            }
        }

        if (!(req.body && req.body.hide_original === false)) {
            const { error } = await supabaseAdmin.from('company_kit_access')
                .upsert({ company_id: companyId, kit_id: master.id, enabled: false }, { onConflict: 'company_id,kit_id' });
            if (error) throw error;
        }
        res.status(201).json({ kit: { id: kit.id, name: kit.name, line_count: copies.length } });
    } catch (err) {
        console.error('Customize kit error:', err);
        if (newId) { try { await supabaseAdmin.from('repair_kits').delete().eq('id', newId); } catch (_) { /* noop */ } }
        res.status(500).json({ error: 'Could not make your copy of that kit.' });
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
        const { priced, unresolved } = await priceKit(companyId, kit.id, multiplier.value, overrides, req.autoMapping);

        const reason = blockedReason(priced, unresolved, req.autoMapping);
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
