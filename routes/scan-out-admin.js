/**
 * routes/scan-out-admin.js
 *
 * CHC-side administration of the scan-out kiosk, mounted from
 * routes/inventory-admin.js at
 *   /api/admin/companies/:companyId/inventory/scan-out
 *
 * Here CHC (or whoever manages the company) decides whether the tablet asks for
 * an ID badge, creates the secret link for each tablet, keeps the badge roster,
 * and prints the badges.
 *
 * Switching the kiosk on or off for a company is the ordinary Modules toggle
 * (`scan_out`); nothing here touches how a company signs in to its store.
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requireCompanyAccess } = require('../middleware/auth');
const { isValidUUID, stripHtml } = require('../utils/sanitize');
const { toSvg } = require('../utils/barcode-128');
const { moduleEnabled, withModule } = require('../utils/modules');
const {
    TRADES,
    newBadgeCode,
    newKioskToken,
    hashKioskToken,
    scanOutOptions,
    cleanTrade
} = require('../utils/scan-out');

const router = express.Router({ mergeParams: true });
router.use(requireCompanyAccess);

const MAX_BADGES = 1000;
const MAX_BULK = 200;
const MAX_DEVICES = 50;

function text(v, max = 120) {
    return stripHtml(String(v === undefined || v === null ? '' : v)).replace(/\s+/g, ' ').trim().slice(0, max);
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

async function loadCompany(companyId) {
    const { data } = await supabaseAdmin
        .from('companies').select('id, name, settings').eq('id', companyId).maybeSingle();
    return data || null;
}

/** Where a tablet opens its link. Behind Railway the public host arrives as a forwarded header. */
function linkFor(req, token) {
    const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
    const proto = process.env.NODE_ENV === 'production' ? 'https' : (req.protocol || 'http');
    return `${proto}://${host}/kiosk/${token}`;
}

/** A badge code no one in this company already holds. */
async function freshBadgeCode(companyId) {
    for (let i = 0; i < 8; i++) {
        const code = newBadgeCode();
        const { data } = await supabaseAdmin
            .from('kiosk_badges').select('id').eq('company_id', companyId).eq('badge_code', code).maybeSingle();
        if (!data) return code;
    }
    throw new Error('Could not mint a unique badge code.');
}

function badgeOut(b) {
    return { id: b.id, name: b.name, trade: b.trade || null, badge_code: b.badge_code, is_active: b.is_active !== false };
}

// ============================================================
// GET /  — everything the console screen needs in one call
// ============================================================
router.get('/', async (req, res) => {
    try {
        const companyId = req.params.companyId;
        const company = await loadCompany(companyId);
        if (!company) return res.status(404).json({ error: 'Company not found.' });

        const [{ data: locations }, { data: devices }, { data: badges }] = await Promise.all([
            supabaseAdmin.from('company_locations').select('id, name, city, is_active')
                .eq('company_id', companyId).eq('is_active', true).order('name'),
            supabaseAdmin.from('kiosk_devices')
                .select('id, name, location_id, is_active, last_seen_at, created_at, revoked_at, token_hint')
                .eq('company_id', companyId).order('created_at', { ascending: false }),
            supabaseAdmin.from('kiosk_badges')
                .select('id, name, trade, badge_code, is_active')
                .eq('company_id', companyId).order('name')
        ]);

        const locName = Object.fromEntries((locations || []).map(l => [l.id, l.name]));

        res.json({
            company: { id: company.id, name: company.name },
            module_enabled: moduleEnabled(company.settings, 'scan_out'),
            inventory_enabled: moduleEnabled(company.settings, 'inventory'),
            options: scanOutOptions(company.settings),
            trades: TRADES,
            locations: locations || [],
            devices: (devices || []).map(d => ({
                id: d.id, name: d.name, location_id: d.location_id,
                location_name: locName[d.location_id] || null,
                is_active: d.is_active !== false,
                last_seen_at: d.last_seen_at || null,
                created_at: d.created_at,
                token_hint: d.token_hint || null
            })),
            badges: (badges || []).map(badgeOut)
        });
    } catch (err) {
        console.error('Scan-out admin load error:', err);
        res.status(500).json({ error: 'Failed to load the scan-out settings.' });
    }
});

// ============================================================
// PUT /settings — the "ask for an ID badge" toggle and the idle clear time
// ============================================================
router.put('/settings', async (req, res) => {
    try {
        const company = await loadCompany(req.params.companyId);
        if (!company) return res.status(404).json({ error: 'Company not found.' });

        const patch = {};
        if (req.body && req.body.require_badge !== undefined) {
            if (typeof req.body.require_badge !== 'boolean') {
                return res.status(400).json({ error: 'require_badge must be true or false.' });
            }
            patch.require_badge = req.body.require_badge;
        }
        if (req.body && req.body.idle_seconds !== undefined) {
            const n = parseInt(req.body.idle_seconds, 10);
            if (!Number.isFinite(n) || n < 20 || n > 600) {
                return res.status(400).json({ error: 'The idle time must be between 20 and 600 seconds.' });
            }
            patch.idle_seconds = n;
        }
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change.' });

        // withModule keeps `enabled` and every other key exactly as it was; the
        // on/off switch belongs to the Modules screen, not this one.
        const settings = withModule(company.settings, 'scan_out', patch);

        const { error } = await supabaseAdmin
            .from('companies')
            .update({ settings, updated_at: new Date().toISOString() })
            .eq('id', company.id);
        if (error) throw error;

        await logAction(req.admin.id, 'scan_out_settings', 'company', company.id, patch, req.ip);

        const options = scanOutOptions(settings);
        res.json({
            message: options.require_badge
                ? 'Updated — people must scan their ID badge before scanning items out.'
                : 'Updated — the ID badge scan is OFF. Items are scanned out without recording who took them.',
            options
        });
    } catch (err) {
        console.error('Scan-out settings error:', err);
        res.status(500).json({ error: 'Failed to save that setting.' });
    }
});

// ============================================================
// DEVICES — one secret link per tablet
// ============================================================

/** Create a tablet. The link is returned ONCE; only its hash is kept. */
router.post('/devices', async (req, res) => {
    try {
        const companyId = req.params.companyId;
        const company = await loadCompany(companyId);
        if (!company) return res.status(404).json({ error: 'Company not found.' });
        if (!moduleEnabled(company.settings, 'scan_out')) {
            return res.status(400).json({ error: 'Turn on the Scan-out kiosk module for this company first.' });
        }

        const name = text(req.body?.name, 60);
        if (!name) return res.status(400).json({ error: 'Give the tablet a name, for example "Paint room tablet".' });

        const locationId = req.body?.location_id;
        if (!isValidUUID(locationId)) return res.status(400).json({ error: 'Choose which location this tablet is in.' });
        const { data: location } = await supabaseAdmin
            .from('company_locations').select('id, name')
            .eq('id', locationId).eq('company_id', companyId).eq('is_active', true).maybeSingle();
        if (!location) return res.status(400).json({ error: 'That location was not found for this company.' });

        const { count } = await supabaseAdmin
            .from('kiosk_devices').select('id', { count: 'exact', head: true })
            .eq('company_id', companyId).eq('is_active', true);
        if ((count || 0) >= MAX_DEVICES) return res.status(400).json({ error: `A company can have up to ${MAX_DEVICES} active tablets.` });

        const token = newKioskToken();
        const { data: device, error } = await supabaseAdmin
            .from('kiosk_devices')
            .insert({
                company_id: companyId, location_id: location.id, name,
                token_hash: hashKioskToken(token), token_hint: token.slice(-4)
            })
            .select('id, name, location_id')
            .single();
        if (error) throw error;

        await logAction(req.admin.id, 'kiosk_device_created', 'kiosk_device', device.id,
            { name, location: location.name }, req.ip);

        res.status(201).json({
            message: `Updated — ${name} is set up.`,
            device: { ...device, location_name: location.name },
            link: linkFor(req, token),
            note: 'Copy this link now and open it on the tablet. For safety it is not shown again; if it is lost, make a new link.'
        });
    } catch (err) {
        console.error('Kiosk device create error:', err);
        res.status(500).json({ error: 'Failed to set up the tablet.' });
    }
});

/** A new link for a tablet. The old link stops working immediately. */
router.post('/devices/:deviceId/regenerate', async (req, res) => {
    try {
        const { companyId, deviceId } = req.params;
        if (!isValidUUID(deviceId)) return res.status(400).json({ error: 'Invalid tablet.' });

        const { data: device } = await supabaseAdmin
            .from('kiosk_devices').select('id, name, is_active')
            .eq('id', deviceId).eq('company_id', companyId).maybeSingle();
        if (!device) return res.status(404).json({ error: 'Tablet not found.' });

        const token = newKioskToken();
        const { error } = await supabaseAdmin
            .from('kiosk_devices')
            .update({ token_hash: hashKioskToken(token), token_hint: token.slice(-4), is_active: true, revoked_at: null })
            .eq('id', deviceId).eq('company_id', companyId);
        if (error) throw error;

        await logAction(req.admin.id, 'kiosk_device_relinked', 'kiosk_device', deviceId, { name: device.name }, req.ip);

        res.json({
            message: `Updated — ${device.name} has a new link. The old one no longer works.`,
            link: linkFor(req, token),
            note: 'Copy this link now and open it on the tablet. It is not shown again.'
        });
    } catch (err) {
        console.error('Kiosk device relink error:', err);
        res.status(500).json({ error: 'Failed to make a new link.' });
    }
});

/** Rename or move a tablet. The link is unchanged. */
router.put('/devices/:deviceId', async (req, res) => {
    try {
        const { companyId, deviceId } = req.params;
        if (!isValidUUID(deviceId)) return res.status(400).json({ error: 'Invalid tablet.' });

        const patch = {};
        if (req.body?.name !== undefined) {
            const name = text(req.body.name, 60);
            if (!name) return res.status(400).json({ error: 'The tablet needs a name.' });
            patch.name = name;
        }
        if (req.body?.location_id !== undefined) {
            if (!isValidUUID(req.body.location_id)) return res.status(400).json({ error: 'Choose a valid location.' });
            const { data: location } = await supabaseAdmin
                .from('company_locations').select('id')
                .eq('id', req.body.location_id).eq('company_id', companyId).eq('is_active', true).maybeSingle();
            if (!location) return res.status(400).json({ error: 'That location was not found for this company.' });
            patch.location_id = location.id;
        }
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change.' });

        const { data, error } = await supabaseAdmin
            .from('kiosk_devices').update(patch)
            .eq('id', deviceId).eq('company_id', companyId).select('id').maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Tablet not found.' });

        await logAction(req.admin.id, 'kiosk_device_updated', 'kiosk_device', deviceId, patch, req.ip);
        res.json({ message: 'Updated — the tablet was saved.' });
    } catch (err) {
        console.error('Kiosk device update error:', err);
        res.status(500).json({ error: 'Failed to save the tablet.' });
    }
});

/** Turn a tablet off. Its link stops working at once; history is kept. */
router.delete('/devices/:deviceId', async (req, res) => {
    try {
        const { companyId, deviceId } = req.params;
        if (!isValidUUID(deviceId)) return res.status(400).json({ error: 'Invalid tablet.' });

        const { data, error } = await supabaseAdmin
            .from('kiosk_devices')
            .update({ is_active: false, revoked_at: new Date().toISOString() })
            .eq('id', deviceId).eq('company_id', companyId)
            .select('id, name').maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Tablet not found.' });

        await logAction(req.admin.id, 'kiosk_device_revoked', 'kiosk_device', deviceId, { name: data.name }, req.ip);
        res.json({ message: `Updated — ${data.name} is switched off and its link no longer works.` });
    } catch (err) {
        console.error('Kiosk device revoke error:', err);
        res.status(500).json({ error: 'Failed to switch the tablet off.' });
    }
});

// ============================================================
// BADGES — the roster
// ============================================================

/** Add one person. */
router.post('/badges', async (req, res) => {
    try {
        const companyId = req.params.companyId;
        const name = text(req.body?.name, 80);
        if (!name) return res.status(400).json({ error: 'Enter the person’s name.' });

        const { count } = await supabaseAdmin
            .from('kiosk_badges').select('id', { count: 'exact', head: true }).eq('company_id', companyId);
        if ((count || 0) >= MAX_BADGES) return res.status(400).json({ error: `A company can have up to ${MAX_BADGES} badges.` });

        const { data, error } = await supabaseAdmin
            .from('kiosk_badges')
            .insert({ company_id: companyId, name, trade: cleanTrade(req.body?.trade), badge_code: await freshBadgeCode(companyId) })
            .select('id, name, trade, badge_code, is_active')
            .single();
        if (error) throw error;

        await logAction(req.admin.id, 'kiosk_badge_created', 'kiosk_badge', data.id, { name }, req.ip);
        res.status(201).json({ message: `Updated — ${name} added.`, badge: badgeOut(data) });
    } catch (err) {
        console.error('Kiosk badge create error:', err);
        res.status(500).json({ error: 'Failed to add that person.' });
    }
});

/** Add many people from a pasted list, one per line, optionally "Name, trade". */
router.post('/badges/bulk', async (req, res) => {
    try {
        const companyId = req.params.companyId;
        const lines = (Array.isArray(req.body?.names) ? req.body.names : String(req.body?.names || '').split(/\r?\n/))
            .map(l => String(l || '').trim()).filter(Boolean);
        if (!lines.length) return res.status(400).json({ error: 'Paste at least one name.' });
        if (lines.length > MAX_BULK) return res.status(400).json({ error: `Add up to ${MAX_BULK} people at a time.` });

        const { count } = await supabaseAdmin
            .from('kiosk_badges').select('id', { count: 'exact', head: true }).eq('company_id', companyId);
        if ((count || 0) + lines.length > MAX_BADGES) return res.status(400).json({ error: `A company can have up to ${MAX_BADGES} badges.` });

        const added = [];
        for (const line of lines) {
            const [namePart, tradePart] = line.split(/[,\t]/);
            const name = text(namePart, 80);
            if (!name) continue;
            const { data, error } = await supabaseAdmin
                .from('kiosk_badges')
                .insert({ company_id: companyId, name, trade: cleanTrade(tradePart), badge_code: await freshBadgeCode(companyId) })
                .select('id, name, trade, badge_code, is_active')
                .single();
            if (error) throw error;
            added.push(badgeOut(data));
        }

        await logAction(req.admin.id, 'kiosk_badges_bulk_created', 'company', companyId, { count: added.length }, req.ip);
        res.status(201).json({ message: `Updated — ${added.length} ${added.length === 1 ? 'person' : 'people'} added.`, badges: added });
    } catch (err) {
        console.error('Kiosk badge bulk error:', err);
        res.status(500).json({ error: 'Failed to add those people.' });
    }
});

/** Rename, change trade, or turn a badge off/on. */
router.put('/badges/:badgeId', async (req, res) => {
    try {
        const { companyId, badgeId } = req.params;
        if (!isValidUUID(badgeId)) return res.status(400).json({ error: 'Invalid badge.' });

        const patch = { updated_at: new Date().toISOString() };
        if (req.body?.name !== undefined) {
            const name = text(req.body.name, 80);
            if (!name) return res.status(400).json({ error: 'The badge needs a name.' });
            patch.name = name;
        }
        if (req.body?.trade !== undefined) patch.trade = cleanTrade(req.body.trade);
        if (req.body?.is_active !== undefined) {
            if (typeof req.body.is_active !== 'boolean') return res.status(400).json({ error: 'is_active must be true or false.' });
            patch.is_active = req.body.is_active;
        }
        if (Object.keys(patch).length === 1) return res.status(400).json({ error: 'Nothing to change.' });

        const { data, error } = await supabaseAdmin
            .from('kiosk_badges').update(patch)
            .eq('id', badgeId).eq('company_id', companyId)
            .select('id, name, trade, badge_code, is_active').maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Badge not found.' });

        await logAction(req.admin.id, 'kiosk_badge_updated', 'kiosk_badge', badgeId, patch, req.ip);
        res.json({ message: 'Updated — the badge was saved.', badge: badgeOut(data) });
    } catch (err) {
        console.error('Kiosk badge update error:', err);
        res.status(500).json({ error: 'Failed to save that badge.' });
    }
});

/** A lost badge: new code, the old card stops working at once. */
router.post('/badges/:badgeId/reissue', async (req, res) => {
    try {
        const { companyId, badgeId } = req.params;
        if (!isValidUUID(badgeId)) return res.status(400).json({ error: 'Invalid badge.' });

        const { data, error } = await supabaseAdmin
            .from('kiosk_badges')
            .update({ badge_code: await freshBadgeCode(companyId), is_active: true, updated_at: new Date().toISOString() })
            .eq('id', badgeId).eq('company_id', companyId)
            .select('id, name, trade, badge_code, is_active').maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Badge not found.' });

        await logAction(req.admin.id, 'kiosk_badge_reissued', 'kiosk_badge', badgeId, { name: data.name }, req.ip);
        res.json({ message: `Updated — ${data.name} has a new badge. The old card no longer works.`, badge: badgeOut(data) });
    } catch (err) {
        console.error('Kiosk badge reissue error:', err);
        res.status(500).json({ error: 'Failed to reissue that badge.' });
    }
});

/**
 * Remove a person. The badge is switched off rather than deleted so the ledger
 * can still say who took what last month.
 */
router.delete('/badges/:badgeId', async (req, res) => {
    try {
        const { companyId, badgeId } = req.params;
        if (!isValidUUID(badgeId)) return res.status(400).json({ error: 'Invalid badge.' });

        const { data, error } = await supabaseAdmin
            .from('kiosk_badges')
            .update({ is_active: false, updated_at: new Date().toISOString() })
            .eq('id', badgeId).eq('company_id', companyId)
            .select('id, name').maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Badge not found.' });

        await logAction(req.admin.id, 'kiosk_badge_deactivated', 'kiosk_badge', badgeId, { name: data.name }, req.ip);
        res.json({ message: `Updated — ${data.name}’s badge is switched off.` });
    } catch (err) {
        console.error('Kiosk badge deactivate error:', err);
        res.status(500).json({ error: 'Failed to switch that badge off.' });
    }
});

// ============================================================
// GET /badges/sheet?ids=a,b,c  (no ids = every active badge)
//
// A print-ready page of ID cards, self-contained like the shelf labels so it
// prints from a shop computer with no internet.
// ============================================================
router.get('/badges/sheet', async (req, res) => {
    try {
        const companyId = req.params.companyId;
        const company = await loadCompany(companyId);
        if (!company) return res.status(404).send('Company not found.');

        let q = supabaseAdmin
            .from('kiosk_badges').select('id, name, trade, badge_code, is_active')
            .eq('company_id', companyId).eq('is_active', true);

        const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
        if (ids.length) {
            if (ids.length > MAX_BADGES || !ids.every(isValidUUID)) return res.status(400).send('Invalid selection.');
            q = q.in('id', ids);
        }
        const { data } = await q.order('name').limit(MAX_BADGES);
        const badges = data || [];
        if (!badges.length) {
            return res.status(404).send('<p style="font-family:system-ui;padding:2rem">No badges to print.</p>');
        }

        const cards = badges.map(b => {
            let svg;
            try { svg = toSvg(b.badge_code, { moduleWidth: 1.8, height: 46, showText: true }); }
            catch (e) { svg = `<div class="nocode">${esc(b.badge_code)}</div>`; }
            return `<div class="card">
  <div class="top"><span class="co">${esc(company.name)}</span><span class="tag">Scan-out ID</span></div>
  <div class="who">${esc(b.name)}</div>
  <div class="trade">${esc(b.trade ? b.trade.charAt(0).toUpperCase() + b.trade.slice(1) : ' ')}</div>
  <div class="code">${svg}</div>
</div>`;
        }).join('\n');

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.send(sheetHtml({ title: `ID badges — ${company.name}`, count: badges.length, cards }));
    } catch (err) {
        console.error('Kiosk badge sheet error:', err);
        res.status(500).send('Failed to build the badge sheet.');
    }
});

// ============================================================
// GET /activity — recent kiosk scan-outs, newest first
// ============================================================
router.get('/activity', async (req, res) => {
    try {
        const companyId = req.params.companyId;
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));

        const { data: rows, error } = await supabaseAdmin
            .from('stock_movements')
            .select('id, product_id, location_id, qty_change, actor_label, badge_id, kiosk_device_id, created_at')
            .eq('company_id', companyId)
            .eq('source_doc_type', 'kiosk_scan')
            .order('created_at', { ascending: false })
            .limit(limit);
        if (error) throw error;

        const ids = [...new Set((rows || []).map(r => r.product_id))];
        let byId = {};
        if (ids.length) {
            const { data: products } = await supabaseAdmin
                .from('products').select('id, sku, name').eq('company_id', companyId).in('id', ids);
            byId = Object.fromEntries((products || []).map(p => [p.id, p]));
        }

        res.json({
            activity: (rows || []).map(r => ({
                id: r.id,
                at: r.created_at,
                who: r.actor_label,
                has_badge: !!r.badge_id,
                sku: byId[r.product_id]?.sku || null,
                item: byId[r.product_id]?.name || null,
                quantity: Math.abs(Number(r.qty_change))
            }))
        });
    } catch (err) {
        console.error('Kiosk activity error:', err);
        res.status(500).json({ error: 'Failed to load recent scan-outs.' });
    }
});

function esc(s) {
    return String(s === null || s === undefined ? '' : s)
        .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function sheetHtml({ title, count, cards }) {
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><title>${esc(title)}</title>
<style>
  :root { --ink:#111827; --muted:#6b7280; --line:#9ca3af; --accent:#1e40af; }
  * { box-sizing: border-box; }
  body { margin:0; padding:16px; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color:var(--ink); background:#f3f4f6; }
  header { display:flex; align-items:baseline; gap:12px; margin-bottom:14px; }
  h1 { font-size:18px; margin:0; }
  .sub { color:var(--muted); font-size:13px; }
  .actions { margin-left:auto; }
  button { font:inherit; padding:8px 14px; border-radius:8px; border:1px solid #d1d5db; background:#fff; cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  .grid { display:grid; gap:8px; grid-template-columns: repeat(auto-fill, 85.6mm); }
  .card { width:85.6mm; height:54mm; background:#fff; border:1px solid var(--line); border-radius:3mm; padding:4mm; display:flex; flex-direction:column; break-inside:avoid; page-break-inside:avoid; }
  .top { display:flex; justify-content:space-between; align-items:baseline; gap:6px; }
  .co { font-weight:700; font-size:10pt; color:#0f2f6b; }
  .tag { font-size:7pt; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); white-space:nowrap; }
  .who { font-size:16pt; font-weight:700; line-height:1.1; margin-top:3mm; overflow:hidden; max-height:2.3em; }
  .trade { font-size:9pt; color:var(--muted); margin-top:1mm; }
  .code { margin-top:auto; text-align:center; }
  .code svg { max-width:100%; height:auto; max-height:20mm; }
  .nocode { font-family:ui-monospace, Menlo, monospace; font-size:11px; }
  @media print {
    body { background:#fff; padding:0; }
    header { display:none; }
    .grid { gap:3mm; }
    @page { margin: 8mm; }
  }
</style>
</head><body>
<header>
  <h1>${esc(title)}</h1>
  <span class="sub">${count} badge${count === 1 ? '' : 's'} · credit-card size</span>
  <span class="actions"><button class="primary" onclick="window.print()">Print</button></span>
</header>
<div class="grid">
${cards}
</div>
</body></html>`;
}

module.exports = router;
