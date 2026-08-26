/**
 * routes/item-library.js
 *
 * The Item Library — the full supplier master catalogue, mounted from
 * routes/admin.js at
 *   /api/admin/companies/:companyId/library
 *
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 *
 * It is a reference shelf: every SKU CHC's suppliers have ever listed, held in
 * one place so a person adding an item to a shop can find the real part number,
 * description and barcode instead of typing one from memory.
 *
 * It is NOT a price list and it is NOT a sale list. Nothing in here is offered
 * to any shop until somebody puts it in that shop's catalogue on purpose, and
 * the price they sell it at is theirs — the library's list_price is a starting
 * point shown to the person adding, never a value that is silently applied.
 *
 * WHY IT IS CALLED A LIBRARY
 *
 * The source file carries no expiry signal at all: is_active and super_by are
 * empty on every row, so nothing in the data distinguishes a discontinued part
 * from a current one. Calling it "old inventory" or "non-selling" would assert
 * staleness the file cannot support, and someone would eventually skip a live
 * part because the screen implied it was dead. "Library" claims only what is
 * true: these are known items, look them up.
 *
 * THE THING THAT WOULD OTHERWISE GO WRONG
 *
 * Two shops that both stock 3M 06652 are two separate products in two separate
 * catalogues at two different prices. Adding from the library must therefore be
 * per company and must refuse to create a SKU the company already has, or the
 * first symptom is a duplicate part number in a live store.
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requireCompanyAccess } = require('../middleware/auth');
const { stripHtml } = require('../utils/sanitize');

const router = express.Router({ mergeParams: true });

router.use(requireCompanyAccess);

const MAX_ADD = 200;

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

/** Same normalisation the library and the database use, so a lookup here and a
 *  lookup there can never disagree about whether two SKUs are the same item. */
function skuKey(sku) {
    return String(sku || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * 7,535 of the 8,618 names in the master arrive with a leading "* ". A marker on
 * 87% of rows carries no information, so it is almost certainly an export
 * artifact rather than a flag — but "almost certainly" is not certain, so the
 * stored value is left exactly as the supplier sent it and the asterisk is
 * stripped only on the way to a screen. If it turns out to mean something, the
 * data is still there to act on.
 */
function displayName(name) {
    return String(name || '').replace(/^\s*\*\s*/, '').trim();
}

// ==================================================================
// Searching
// ==================================================================

/**
 * GET /library
 *   ?q=            free text: full SKU, partial SKU, barcode, or words
 *   ?vendors=MMM,NOR
 *   ?only_new=1    hide anything this company already sells
 *   ?limit= &offset=
 *
 * The "already in this catalogue" flag is computed in the same query as the
 * search rather than checked afterwards, so the console can never offer to add
 * something the shop already has.
 */
router.get('/', async (req, res) => {
    try {
        const companyId = req.params.companyId;

        const q = stripHtml(String(req.query.q || '')).slice(0, 120);
        const vendors = String(req.query.vendors || '')
            .split(',')
            .map(v => v.trim().toUpperCase())
            .filter(v => /^[A-Z0-9]{1,10}$/.test(v));

        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const onlyNew = req.query.only_new === '1' || req.query.only_new === 'true';

        const { data, error } = await supabaseAdmin.rpc('search_item_library', {
            p_company_id: companyId,
            p_query: q,
            p_vendors: vendors.length ? vendors : null,
            p_only_new: onlyNew,
            p_limit: limit,
            p_offset: offset
        });
        if (error) throw error;

        const rows = data || [];
        res.json({
            items: rows.map(r => ({
                id: r.id,
                sku: r.sku,
                name: displayName(r.name),
                brand: r.brand,
                vendor_code: r.vendor_code,
                barcode: r.barcode,
                unit: r.unit,
                case_qty: r.case_qty,
                // Named suggested_price, not price. It is what the supplier
                // listed, not what this shop charges, and the console must not
                // let the two blur together.
                suggested_price: r.list_price,
                already_in_catalogue: r.already_in_catalogue,
                existing_product_id: r.existing_product_id
            })),
            total: rows.length ? Number(rows[0].total_count) : 0,
            limit,
            offset
        });
    } catch (err) {
        console.error('Item library search error:', err);
        res.status(500).json({ error: 'Failed to search the item library.' });
    }
});

/**
 * GET /library/vendors
 * What is actually in the library, for the filter row.
 */
router.get('/vendors', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('item_library')
            .select('vendor_code, brand')
            .not('vendor_code', 'is', null);
        if (error) throw error;

        const byCode = new Map();
        for (const r of data || []) {
            const cur = byCode.get(r.vendor_code) || { vendor_code: r.vendor_code, brand: r.brand, count: 0 };
            cur.count += 1;
            if (!cur.brand && r.brand) cur.brand = r.brand;
            byCode.set(r.vendor_code, cur);
        }

        res.json({
            vendors: [...byCode.values()].sort((a, b) => b.count - a.count),
            total: (data || []).length
        });
    } catch (err) {
        console.error('Item library vendors error:', err);
        res.status(500).json({ error: 'Failed to load vendors.' });
    }
});

// ==================================================================
// Adding to a company's catalogue
// ==================================================================

/**
 * POST /library/add
 * body: { items: [{ library_id, price?, price_on_request?, category?, case_qty? }] }
 *
 * Deliberate rules:
 *
 *   * A price is required, or the item must be explicitly marked
 *     "Contact for current pricing". There is no silent zero — a $0 line in a
 *     live store is an order CHC cannot invoice.
 *   * A SKU the company already has is skipped, never overwritten. The shop's
 *     own name and price are the ones on their shelves.
 *   * The barcode comes across only if it does not already point at a different
 *     product in this company. An ambiguous scan is worse than no scan.
 *
 * Partial success is reported honestly: added, skipped and failed are three
 * different outcomes and the console shows all three.
 */
router.post('/add', async (req, res) => {
    try {
        const companyId = req.params.companyId;
        const items = Array.isArray(req.body?.items) ? req.body.items : [];

        if (!items.length) return res.status(400).json({ error: 'No items supplied.' });
        if (items.length > MAX_ADD) {
            return res.status(400).json({ error: `Add at most ${MAX_ADD} items at a time.` });
        }

        const ids = [...new Set(items.map(i => String(i.library_id || '')).filter(Boolean))];
        if (!ids.length) return res.status(400).json({ error: 'No valid library items supplied.' });

        const { data: libRows, error: libErr } = await supabaseAdmin
            .from('item_library')
            .select('id, sku, sku_key, name, brand, vendor_code, barcode, unit, case_qty, list_price')
            .in('id', ids);
        if (libErr) throw libErr;

        const lib = new Map((libRows || []).map(r => [r.id, r]));

        // What this company already sells, keyed the same way as the library.
        const { data: existing, error: exErr } = await supabaseAdmin
            .from('products')
            .select('id, sku')
            .eq('company_id', companyId);
        if (exErr) throw exErr;

        const have = new Map();
        for (const p of existing || []) {
            const k = skuKey(p.sku);
            if (k) have.set(k, p.id);
        }

        // Barcodes already in use in this company, so we never create an
        // ambiguous scan on the way in.
        const productIds = (existing || []).map(p => p.id);
        const usedBarcodes = new Set();
        if (productIds.length) {
            const { data: bcs } = await supabaseAdmin
                .from('product_barcodes')
                .select('barcode')
                .in('product_id', productIds);
            for (const b of bcs || []) usedBarcodes.add(b.barcode);
        }

        const added = [];
        const skipped = [];
        const failed = [];

        for (const req_item of items) {
            const row = lib.get(String(req_item.library_id || ''));
            if (!row) {
                failed.push({ library_id: req_item.library_id, reason: 'not_in_library' });
                continue;
            }

            if (have.has(row.sku_key)) {
                skipped.push({ sku: row.sku, reason: 'already_in_catalogue' });
                continue;
            }

            const onRequest = req_item.price_on_request === true || req_item.price_on_request === 'true';
            const rawPrice = req_item.price;
            const price = rawPrice === undefined || rawPrice === null || rawPrice === ''
                ? null
                : Number(rawPrice);

            if (!onRequest && (price === null || !Number.isFinite(price) || price < 0)) {
                failed.push({
                    sku: row.sku,
                    reason: 'price_required',
                    suggested_price: row.list_price
                });
                continue;
            }

            const product = {
                company_id: companyId,
                sku: row.sku,
                name: stripHtml(String(req_item.name || displayName(row.name))).slice(0, 200),
                brand: stripHtml(String(req_item.brand || row.brand || row.vendor_code || 'Unknown')).slice(0, 100),
                category: req_item.category ? stripHtml(String(req_item.category)).slice(0, 100) : null,
                price: onRequest ? 0 : price,
                price_on_request: onRequest,
                unit: (req_item.unit || row.unit || 'each').toString().toLowerCase().slice(0, 40),
                case_qty: Number.isFinite(Number(req_item.case_qty ?? row.case_qty))
                    ? Math.max(1, Math.round(Number(req_item.case_qty ?? row.case_qty)))
                    : 1,
                is_active: true,
                metadata: { added_from: 'item_library', item_library_id: row.id }
            };

            const { data: created, error: insErr } = await supabaseAdmin
                .from('products')
                .insert(product)
                .select('id, sku, name, price, price_on_request')
                .single();

            if (insErr || !created) {
                failed.push({ sku: row.sku, reason: 'insert_failed' });
                continue;
            }

            have.set(row.sku_key, created.id);

            let barcodeApplied = false;
            if (row.barcode && !usedBarcodes.has(row.barcode)) {
                const { error: bcErr } = await supabaseAdmin
                    .from('product_barcodes')
                    .insert({
                        product_id: created.id,
                        barcode: row.barcode,
                        symbology: 'upc_a',
                        is_primary: true,
                        source: 'item_library',
                        is_internal: false
                    });
                if (!bcErr) {
                    usedBarcodes.add(row.barcode);
                    barcodeApplied = true;
                }
            }

            added.push({
                product_id: created.id,
                sku: created.sku,
                name: created.name,
                price: created.price,
                price_on_request: created.price_on_request,
                barcode_applied: barcodeApplied,
                barcode_skipped_as_duplicate: Boolean(row.barcode) && !barcodeApplied
            });
        }

        if (added.length) {
            await logAction(
                req.admin.id, 'products_added_from_library', 'company', companyId,
                { added: added.length, skipped: skipped.length, failed: failed.length,
                  skus: added.map(a => a.sku).slice(0, 50) },
                req.ip
            );
        }

        res.status(added.length ? 201 : 200).json({
            added, skipped, failed,
            summary: { added: added.length, skipped: skipped.length, failed: failed.length }
        });
    } catch (err) {
        console.error('Add from library error:', err);
        res.status(500).json({ error: 'Failed to add items from the library.' });
    }
});

// ==================================================================
// Barcodes that need a person
// ==================================================================

/**
 * GET /library/conflicts
 *
 * Barcodes the import refused to apply because a scan of them would be
 * ambiguous — most often a case and a single unit sharing one manufacturer
 * barcode. Left visible rather than silently dropped, because a missing barcode
 * that nobody knows about is how a stock count quietly goes wrong.
 */
router.get('/conflicts', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('item_library_conflicts')
            .select('id, product_id, sku, barcode, reason, created_at')
            .eq('company_id', req.params.companyId)
            .is('resolved_at', null)
            .order('barcode');
        if (error) throw error;
        res.json({ conflicts: data || [] });
    } catch (err) {
        console.error('Library conflicts error:', err);
        res.status(500).json({ error: 'Failed to load barcode conflicts.' });
    }
});

/**
 * POST /library/conflicts/:id/resolve
 * body: { apply: boolean }
 *
 * apply=true attaches the barcode to this product anyway — the right call when
 * a person has checked the shelf and knows which item it belongs to.
 * apply=false simply marks it dealt with.
 */
router.post('/conflicts/:id/resolve', async (req, res) => {
    try {
        const companyId = req.params.companyId;

        const { data: row, error } = await supabaseAdmin
            .from('item_library_conflicts')
            .select('id, product_id, sku, barcode, company_id, resolved_at')
            .eq('id', req.params.id)
            .eq('company_id', companyId)
            .maybeSingle();
        if (error) throw error;
        if (!row) return res.status(404).json({ error: 'Conflict not found.' });
        if (row.resolved_at) return res.status(409).json({ error: 'Already resolved.' });

        const apply = req.body?.apply === true || req.body?.apply === 'true';

        if (apply) {
            const { error: bcErr } = await supabaseAdmin
                .from('product_barcodes')
                .insert({
                    product_id: row.product_id,
                    barcode: row.barcode,
                    symbology: 'upc_a',
                    is_primary: false,
                    source: 'item_library_resolved',
                    is_internal: false
                });
            if (bcErr) throw bcErr;
        }

        await supabaseAdmin
            .from('item_library_conflicts')
            .update({ resolved_at: new Date().toISOString(), resolved_by: req.admin.id })
            .eq('id', row.id);

        await logAction(
            req.admin.id, apply ? 'library_barcode_applied' : 'library_barcode_dismissed',
            'product', row.product_id, { sku: row.sku, barcode: row.barcode }, req.ip
        );

        res.json({ resolved: true, applied: apply });
    } catch (err) {
        console.error('Resolve conflict error:', err);
        res.status(500).json({ error: 'Failed to resolve the conflict.' });
    }
});

module.exports = router;
