/**
 * routes/inventory-labels.js
 *
 * refinishAI Inventory, phase 4 — internal barcodes and printable cards.
 * Mounted from routes/inventory-admin.js at
 *   /api/admin/companies/:companyId/inventory/labels
 *
 * 316 of the 881 items on the CHC master file carry no manufacturer UPC —
 * decanted paint, kits, private label. Those need a barcode of CHC's own so the
 * shop floor can scan them like anything else, plus a physical card to put on
 * the shelf, the way PPG's ColorVision cards and Skyline's labels work.
 *
 * Internal codes are Code 128, generated as SVG with no third-party library
 * (see utils/barcode-128.js).
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requireCompanyAccess } = require('../middleware/auth');
const { isValidUUID, stripHtml } = require('../utils/sanitize');
const { toSvg } = require('../utils/barcode-128');
const { detectSymbology } = require('../utils/inventory');

const router = express.Router({ mergeParams: true });
router.use(requireCompanyAccess);

/** Prefix that marks a code as one we minted rather than a manufacturer's. */
const INTERNAL_PREFIX = 'RAI';

/**
 * Build an internal code from the part number.
 *
 * Deliberately derived from the SKU rather than random: a label that has fallen
 * off a shelf can be regenerated identically, and a human can read the code and
 * know what it is. Code 128 covers the full printable ASCII set, so the only
 * normalisation needed is upper-casing and dropping characters that confuse
 * label printers.
 *
 * That stripping can collapse two distinct part numbers onto one code — the CHC
 * catalogue really does contain both `GLO@750M-5G` and `GLO750M-5G`, which both
 * reduce to `GLO750M-5G`. A shared code means a scan cannot resolve to one item,
 * so whenever a character is dropped or the SKU is truncated, a short checksum
 * of the original is appended. It stays deterministic, so the label is still
 * reproducible from the part number alone.
 */
function internalCodeFor(sku) {
    const raw = String(sku || '').trim();
    if (!raw) return null;

    const upper = raw.toUpperCase();
    const clean = upper.replace(/[^A-Z0-9\-.\/+]/g, '').slice(0, 24);
    if (!clean) return null;

    const lossless = clean === upper;
    return lossless
        ? `${INTERNAL_PREFIX}-${clean}`
        : `${INTERNAL_PREFIX}-${clean}-${skuChecksum(raw)}`;
}

/** Two base-36 characters derived from the original part number. */
function skuChecksum(raw) {
    let h = 0;
    for (let i = 0; i < raw.length; i++) {
        h = (h * 31 + raw.charCodeAt(i)) >>> 0;
    }
    return (h % 1296).toString(36).toUpperCase().padStart(2, '0');
}

function text(v, max = 200) {
    return stripHtml(String(v === undefined || v === null ? '' : v)).trim().slice(0, max);
}

async function logAction(adminId, action, entityType, entityId, details, ip) {
    try {
        await supabaseAdmin.from('audit_log').insert({
            admin_id: adminId, action, entity_type: entityType,
            entity_id: entityId, details, ip_address: ip
        });
    } catch (err) { console.error('Audit log write failed:', err); }
}

// ============================================================
// GENERATING INTERNAL CODES
// ============================================================

/**
 * GET /labels/candidates?limit=
 * Items with no barcode at all — the ones that need a code minting.
 */
router.get('/candidates', async (req, res) => {
    try {
        const companyId = req.params.companyId;
        const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit) || 500));

        const { data: products, error } = await supabaseAdmin
            .from('products')
            .select('id, sku, name, brand, category')
            .eq('company_id', companyId)
            .eq('is_active', true)
            .order('brand').order('name')
            .limit(limit);
        if (error) throw error;

        const ids = (products || []).map(p => p.id);
        const coded = new Set();
        for (let i = 0; i < ids.length; i += 200) {
            const { data: codes } = await supabaseAdmin
                .from('product_barcodes').select('product_id').in('product_id', ids.slice(i, i + 200));
            for (const c of codes || []) coded.add(c.product_id);
        }

        const candidates = (products || [])
            .filter(p => !coded.has(p.id))
            .map(p => ({ ...p, proposed_code: internalCodeFor(p.sku) }))
            .filter(p => p.proposed_code);

        res.json({
            scanned: (products || []).length,
            already_coded: coded.size,
            candidates
        });
    } catch (err) {
        console.error('Label candidates error:', err);
        res.status(500).json({ error: 'Failed to find items needing labels.' });
    }
});

/**
 * POST /labels/generate
 * Body: { product_ids?: [], all_uncoded?: bool, dry_run?: bool }
 *
 * Mints an internal Code 128 for each item that has none. Idempotent: an item
 * that already carries its internal code is left alone, so this can be re-run
 * after every catalogue update.
 */
router.post('/generate', async (req, res) => {
    try {
        const companyId = req.params.companyId;
        const dryRun = !!req.body?.dry_run;

        let products = [];
        if (Array.isArray(req.body?.product_ids) && req.body.product_ids.length) {
            const ids = req.body.product_ids.filter(isValidUUID).slice(0, 2000);
            if (!ids.length) return res.status(400).json({ error: 'No valid products supplied.' });
            const { data } = await supabaseAdmin
                .from('products').select('id, sku, name')
                .eq('company_id', companyId).in('id', ids);
            products = data || [];
        } else if (req.body?.all_uncoded) {
            const { data } = await supabaseAdmin
                .from('products').select('id, sku, name')
                .eq('company_id', companyId).eq('is_active', true).limit(5000);
            const all = data || [];
            const coded = new Set();
            const ids = all.map(p => p.id);
            for (let i = 0; i < ids.length; i += 200) {
                const { data: codes } = await supabaseAdmin
                    .from('product_barcodes').select('product_id').in('product_id', ids.slice(i, i + 200));
                for (const c of codes || []) coded.add(c.product_id);
            }
            products = all.filter(p => !coded.has(p.id));
        } else {
            return res.status(400).json({ error: 'Supply product_ids, or set all_uncoded.' });
        }

        const created = [];
        const skipped = [];

        for (const product of products) {
            const code = internalCodeFor(product.sku);
            if (!code) { skipped.push({ sku: product.sku, reason: 'no usable part number' }); continue; }

            const { data: existing } = await supabaseAdmin
                .from('product_barcodes')
                .select('id').eq('product_id', product.id).eq('barcode', code).maybeSingle();
            if (existing) { skipped.push({ sku: product.sku, reason: 'already has this code' }); continue; }

            if (!dryRun) {
                const { error } = await supabaseAdmin.from('product_barcodes').insert({
                    product_id: product.id,
                    barcode: code,
                    symbology: detectSymbology(code) === 'code_39' ? 'code_128' : 'code_128',
                    is_primary: false,
                    is_internal: true,
                    source: 'generated'
                });
                if (error) { skipped.push({ sku: product.sku, reason: error.message }); continue; }
            }
            created.push({ product_id: product.id, sku: product.sku, name: product.name, barcode: code });
        }

        if (!dryRun && created.length) {
            await logAction(req.admin.id, 'internal_barcodes_generated', 'company', companyId,
                { count: created.length }, req.ip);
        }

        res.json({
            preview: dryRun,
            message: dryRun
                ? `${created.length} code${created.length === 1 ? '' : 's'} would be created.`
                : `${created.length} internal code${created.length === 1 ? '' : 's'} created.`,
            created: created.length,
            skipped: skipped.length,
            codes: created.slice(0, 200),
            skipped_details: skipped.slice(0, 50)
        });
    } catch (err) {
        console.error('Generate labels error:', err);
        res.status(500).json({ error: 'Failed to generate internal codes.' });
    }
});

// ============================================================
// PRINTING
// ============================================================

/**
 * GET /labels/barcode.svg?code=
 * A single barcode as SVG — handy for embedding, and for checking a code scans
 * before committing a whole sheet to paper.
 */
router.get('/barcode.svg', (req, res) => {
    try {
        const code = String(req.query.code || '').trim();
        if (!code || code.length > 48) return res.status(400).send('A code of 1-48 characters is required.');

        const svg = toSvg(code, {
            moduleWidth: clamp(parseFloat(req.query.mw) || 2, 1, 6),
            height: clamp(parseInt(req.query.h) || 60, 20, 200),
            showText: req.query.text !== '0'
        });
        res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(svg);
    } catch (err) {
        res.status(400).send(String(err.message || 'Could not render that code.'));
    }
});

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo)); }

/**
 * GET /labels/sheet?location_id=&format=shelf|reorder&status=&limit=
 *
 * A print-ready page of cards. Two formats:
 *   shelf   — bin label: item, part number, barcode, bin, min/max
 *   reorder — a card the shop keeps by the shelf and scans to reorder, in the
 *             spirit of PPG's ColorVision cards
 *
 * Returned as self-contained HTML with a print stylesheet rather than a PDF:
 * every shop already has a browser, label stock varies wildly between them, and
 * @page margins are far easier to adjust than a regenerated PDF.
 */
router.get('/sheet', async (req, res) => {
    try {
        const companyId = req.params.companyId;
        const format = req.query.format === 'reorder' ? 'reorder' : 'shelf';
        const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));

        const { data: company } = await supabaseAdmin
            .from('companies').select('name').eq('id', companyId).maybeSingle();

        let location = null;
        if (req.query.location_id && isValidUUID(req.query.location_id)) {
            const { data } = await supabaseAdmin
                .from('company_locations').select('id, name')
                .eq('id', req.query.location_id).eq('company_id', companyId).maybeSingle();
            location = data || null;
        }

        // Prefer levels (they carry bin and reorder points); fall back to the
        // catalogue when the company has not seeded stock yet.
        let rows = [];
        if (location) {
            let q = supabaseAdmin
                .from('inventory_status')
                .select('product_id, sku, product_name, brand, on_hand, min_point, max_point, bin_location, stock_status')
                .eq('company_id', companyId).eq('location_id', location.id);
            if (req.query.status && ['low', 'out', 'ok'].includes(req.query.status)) {
                q = q.eq('stock_status', req.query.status);
            }
            const { data } = await q.order('product_name').limit(limit);
            rows = data || [];
        } else {
            const { data } = await supabaseAdmin
                .from('products').select('id, sku, name, brand')
                .eq('company_id', companyId).eq('is_active', true).order('brand').order('name').limit(limit);
            rows = (data || []).map(p => ({
                product_id: p.id, sku: p.sku, product_name: p.name, brand: p.brand,
                on_hand: null, min_point: null, max_point: null, bin_location: null
            }));
        }

        if (!rows.length) {
            return res.status(404).send('<p style="font-family:system-ui;padding:2rem">Nothing to print for that selection.</p>');
        }

        // One barcode per item: its primary, else any manufacturer code, else
        // the internal one we can mint on the fly for the label.
        const ids = rows.map(r => r.product_id);
        const codeByProduct = {};
        for (let i = 0; i < ids.length; i += 200) {
            const { data: codes } = await supabaseAdmin
                .from('product_barcodes')
                .select('product_id, barcode, is_primary, is_internal')
                .in('product_id', ids.slice(i, i + 200));
            for (const c of codes || []) {
                const cur = codeByProduct[c.product_id];
                if (!cur || (c.is_primary && !cur.is_primary)) codeByProduct[c.product_id] = c;
            }
        }

        const cards = rows.map(r => {
            const found = codeByProduct[r.product_id];
            const code = found ? found.barcode : internalCodeFor(r.sku);
            let svg = '';
            if (code) {
                try {
                    svg = toSvg(code, { moduleWidth: format === 'reorder' ? 2 : 1.6, height: format === 'reorder' ? 56 : 44 });
                } catch (e) { svg = `<div class="nocode">${escapeHtml(code)}</div>`; }
            } else {
                svg = '<div class="nocode">No barcode</div>';
            }
            return renderCard(r, svg, format, !found);
        }).join('\n');

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(sheetHtml({
            title: `${format === 'reorder' ? 'Reorder cards' : 'Shelf labels'} — ${company?.name || 'CHC'}`,
            subtitle: [company?.name, location?.name].filter(Boolean).join(' · '),
            count: rows.length,
            format,
            cards
        }));
    } catch (err) {
        console.error('Label sheet error:', err);
        res.status(500).send('<p style="font-family:system-ui;padding:2rem">Failed to build that label sheet.</p>');
    }
});

function renderCard(r, svg, format, provisional) {
    const min = r.min_point ?? '—';
    const max = r.max_point ?? '—';
    const bin = r.bin_location ? escapeHtml(r.bin_location) : '';

    if (format === 'reorder') {
        return `
  <div class="card reorder">
    <div class="brandbar">
      <span class="brandmark">refinish<b>AI</b></span>
      <span class="brandnote">Scan to reorder</span>
    </div>
    <div class="name">${escapeHtml(r.product_name || '')}</div>
    <div class="meta">${escapeHtml(r.brand || '')}${r.sku ? ' · ' + escapeHtml(r.sku) : ''}</div>
    <div class="code">${svg}</div>
    <div class="points">
      <span>Min <b>${min}</b></span><span>Max <b>${max}</b></span>${bin ? `<span>Bin <b>${bin}</b></span>` : ''}
    </div>
    ${provisional ? '<div class="warn">Provisional code — generate internal labels to register it</div>' : ''}
  </div>`;
    }

    return `
  <div class="card shelf">
    <div class="name">${escapeHtml(r.product_name || '')}</div>
    <div class="meta">${escapeHtml(r.brand || '')}${r.sku ? ' · <b>' + escapeHtml(r.sku) + '</b>' : ''}</div>
    <div class="code">${svg}</div>
    <div class="points"><span>Min <b>${min}</b></span><span>Max <b>${max}</b></span>${bin ? `<span>Bin <b>${bin}</b></span>` : ''}</div>
  </div>`;
}

function sheetHtml({ title, subtitle, count, format, cards }) {
    // Deliberately self-contained: no CDN, so this prints correctly from a shop
    // computer with no internet, which is more common than you would like.
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  :root { --ink:#111827; --muted:#6b7280; --line:#d1d5db; --accent:#1e40af; }
  * { box-sizing: border-box; }
  body { margin:0; padding:16px; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color:var(--ink); background:#f3f4f6; }
  header { display:flex; align-items:baseline; gap:12px; margin-bottom:14px; }
  h1 { font-size:18px; margin:0; }
  .sub { color:var(--muted); font-size:13px; }
  .actions { margin-left:auto; }
  button { font:inherit; padding:8px 14px; border-radius:8px; border:1px solid var(--line); background:#fff; cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  .grid { display:grid; gap:8px; grid-template-columns: repeat(${format === 'reorder' ? 2 : 3}, 1fr); }
  .card { background:#fff; border:1px solid var(--line); border-radius:8px; padding:10px; break-inside:avoid; page-break-inside:avoid; }
  .brandbar { display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; }
  .brandmark { font-weight:700; font-size:12px; color:#0f2f6b; }
  .brandmark b { color:#2b9be8; }
  .brandnote { font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
  .name { font-weight:600; font-size:13px; line-height:1.25; min-height:2.4em; overflow:hidden; }
  .meta { color:var(--muted); font-size:11px; margin:2px 0 6px; }
  .code { text-align:center; }
  .code svg { max-width:100%; height:auto; }
  .nocode { font-family:ui-monospace, Menlo, monospace; font-size:11px; color:var(--muted); padding:14px 0; }
  .points { display:flex; gap:10px; font-size:11px; color:var(--muted); margin-top:6px; border-top:1px dashed var(--line); padding-top:5px; }
  .warn { margin-top:5px; font-size:10px; color:#92400e; background:#fef3c7; border-radius:4px; padding:3px 5px; }
  @media print {
    body { background:#fff; padding:0; }
    header { display:none; }
    .card { border-color:#9ca3af; }
    @page { margin: 10mm; }
  }
</style>
</head><body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <span class="sub">${escapeHtml(subtitle)} · ${count} card${count === 1 ? '' : 's'}</span>
  <span class="actions"><button class="primary" onclick="window.print()">Print</button></span>
</header>
<div class="grid">
${cards}
</div>
</body></html>`;
}

function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s)
        .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = router;
module.exports.internalCodeFor = internalCodeFor;
module.exports.skuChecksum = skuChecksum;
