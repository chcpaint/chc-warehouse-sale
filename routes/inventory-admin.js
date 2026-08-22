/**
 * routes/inventory-admin.js
 *
 * refinishAI Inventory — CHC-side administration, mounted from routes/admin.js at
 *   /api/admin/companies/:companyId/inventory
 *
 * Mounted as a sub-router (mergeParams) so no change to server.js is needed.
 * The parent router already applies requireAdminAuth; requireCompanyAccess is
 * re-applied here so the file cannot be remounted somewhere less protected.
 *
 * This is where CHC turns inventory on for a customer, seeds it from the master
 * product file, and manages barcodes and reorder points across locations.
 */

const express = require('express');
const crypto = require('node:crypto');
const csv = require('csv-parser');
const XLSX = require('xlsx');
const { Readable } = require('stream');
const { supabaseAdmin } = require('../utils/supabase');
const { requireCompanyAccess } = require('../middleware/auth');
const { catalogUpload } = require('../middleware/upload');
const { stripHtml, isValidUUID } = require('../utils/sanitize');
const { validEmails } = require('../utils/recipients');
const { sendLowStockAlert } = require('../utils/email');
const {
    MOVEMENT_TYPE_NAMES,
    normalizeMasterRow,
    canonicalBarcode,
    detectSymbology,
    barcodeVariants,
    movementDelta,
    inventorySettings,
    DEFAULT_INVENTORY_SETTINGS
} = require('../utils/inventory');

const router = express.Router({ mergeParams: true });

router.use(requireCompanyAccess);

const MAX_UPLOAD_ROWS = 10000;

function text(v, max = 200) {
    return stripHtml(String(v === undefined || v === null ? '' : v)).trim().slice(0, max);
}

/** Audit-log helper mirroring the one in routes/admin.js. */
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

async function resolveLocation(companyId, locationId) {
    if (!locationId || !isValidUUID(locationId)) return null;
    const { data } = await supabaseAdmin
        .from('company_locations')
        .select('id, name, city, is_active')
        .eq('id', locationId).eq('company_id', companyId).maybeSingle();
    return data || null;
}

// ============================================================
// INTERNAL BARCODES AND PRINTABLE CARDS (phase 4)
// ============================================================
router.use('/labels', require('./inventory-labels'));

// ============================================================
// REPAIR KITS — access, mapping and company-owned kits
// ============================================================
router.use('/kits', require('./inventory-kits-admin'));

// ============================================================
// SETTINGS — the per-company on/off switch
// ============================================================

/** GET /api/admin/companies/:companyId/inventory/settings */
router.get('/settings', async (req, res) => {
    try {
        const company = await loadCompany(req.params.companyId);
        if (!company) return res.status(404).json({ error: 'Company not found.' });

        const { count: locationCount } = await supabaseAdmin
            .from('company_locations').select('id', { count: 'exact', head: true })
            .eq('company_id', company.id).eq('is_active', true);

        const { count: trackedCount } = await supabaseAdmin
            .from('inventory_levels').select('id', { count: 'exact', head: true })
            .eq('company_id', company.id);

        res.json({
            settings: inventorySettings(company.settings),
            defaults: DEFAULT_INVENTORY_SETTINGS,
            active_locations: locationCount || 0,
            tracked_levels: trackedCount || 0
        });
    } catch (err) {
        console.error('Inventory settings read error:', err);
        res.status(500).json({ error: 'Failed to load inventory settings.' });
    }
});

/**
 * PUT /api/admin/companies/:companyId/inventory/settings
 * Body: { enabled, auto_draft, require_approval, allow_negative, scan_sound, alert_emails[] }
 *
 * Writes only the `inventory` key of companies.settings — every other setting
 * on the company is read back and preserved.
 */
router.put('/settings', async (req, res) => {
    try {
        const company = await loadCompany(req.params.companyId);
        if (!company) return res.status(404).json({ error: 'Company not found.' });

        const current = inventorySettings(company.settings);
        const body = req.body || {};
        const bool = (key) => (body[key] === undefined ? current[key] : !!body[key]);

        const next = {
            enabled:          bool('enabled'),
            auto_draft:       bool('auto_draft'),
            require_approval: bool('require_approval'),
            allow_negative:   bool('allow_negative'),
            scan_sound:       bool('scan_sound'),
            alert_emails:     body.alert_emails === undefined
                ? current.alert_emails
                : validEmails(Array.isArray(body.alert_emails) ? body.alert_emails : String(body.alert_emails).split(/[\s,;]+/)).slice(0, 25)
        };

        const mergedSettings = { ...(company.settings || {}), inventory: next };

        const { data, error } = await supabaseAdmin
            .from('companies')
            .update({ settings: mergedSettings, updated_at: new Date().toISOString() })
            .eq('id', company.id)
            .select('id, settings')
            .single();
        if (error) throw error;

        await logAction(req.admin.id, 'inventory_settings_updated', 'company', company.id, next, req.ip);
        res.json({ settings: inventorySettings(data.settings) });
    } catch (err) {
        console.error('Inventory settings write error:', err);
        res.status(500).json({ error: 'Failed to save inventory settings.' });
    }
});

// ============================================================
// MASTER FILE UPLOAD
// ============================================================

function parseCSV(buffer) {
    return new Promise((resolve, reject) => {
        const rows = [];
        Readable.from(buffer.toString('utf8'))
            .pipe(csv())
            .on('data', row => rows.push(row))
            .on('end', () => resolve(rows))
            .on('error', reject);
    });
}

function parseExcel(buffer) {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const rows = [];
    for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        for (const row of XLSX.utils.sheet_to_json(sheet, { defval: '' })) {
            // Carry the sheet name through as a brand hint, the same convention
            // the catalogue importer in routes/admin.js uses.
            if (!row.Brand && !row.brand && !row.Manufacturer) row._sheet_brand = sheetName.trim();
            rows.push(row);
        }
    }
    return rows;
}

/**
 * POST /api/admin/companies/:companyId/inventory/master-upload
 *
 * Multipart: catalog=<file>
 * Body: mode=master|seed, location_id (required for seed), dry_run=1
 *
 *   master — govern the catalogue: upsert products by SKU and attach barcodes.
 *   seed   — the above, plus create inventory_levels at one location, with an
 *            opening-balance ledger entry for any on-hand quantity in the file.
 *
 * Always run with dry_run first from the UI: the response is the same shape,
 * with nothing written, so the buyer can see the damage before committing.
 */
router.post('/master-upload', catalogUpload.single('catalog'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file provided.' });

        const companyId = req.params.companyId;
        const company = await loadCompany(companyId);
        if (!company) return res.status(404).json({ error: 'Company not found.' });

        const mode = String(req.body.mode || 'master').toLowerCase();
        if (!['master', 'seed'].includes(mode)) {
            return res.status(400).json({ error: 'Mode must be "master" or "seed".' });
        }

        const dryRun = ['1', 'true', 'yes'].includes(String(req.body.dry_run || req.query.preview || '').toLowerCase());

        let location = null;
        if (mode === 'seed') {
            location = await resolveLocation(companyId, req.body.location_id);
            if (!location) return res.status(400).json({ error: 'Seeding requires a valid location.' });
        }

        const ext = String(req.file.originalname || '').split('.').pop().toLowerCase();
        let rows;
        if (ext === 'csv') rows = await parseCSV(req.file.buffer);
        else if (ext === 'xlsx' || ext === 'xls') rows = parseExcel(req.file.buffer);
        else return res.status(400).json({ error: 'Unsupported file type. Use CSV or XLSX.' });

        if (!rows.length) return res.status(400).json({ error: 'No data rows found in the file.' });
        if (rows.length > MAX_UPLOAD_ROWS) {
            return res.status(400).json({ error: `Maximum ${MAX_UPLOAD_ROWS.toLocaleString()} rows per upload.` });
        }

        // ---- Parse and validate every row before touching the database -------
        const parsed = [];
        const errors = [];
        const seenSku = new Map();
        const barcodeOwners = new Map();

        rows.forEach((row, idx) => {
            const rowNumber = idx + 2;                     // +1 for header, +1 for 1-based
            const result = normalizeMasterRow(row);
            if (!result.ok) {
                errors.push({ row: rowNumber, error: result.error });
                return;
            }
            const value = result.value;

            if (seenSku.has(value.sku)) {
                errors.push({ row: rowNumber, error: `Duplicate item number "${value.sku}" (also on row ${seenSku.get(value.sku)})` });
                return;
            }
            seenSku.set(value.sku, rowNumber);

            if (value.barcode) {
                const owners = barcodeOwners.get(value.barcode) || [];
                owners.push(value.sku);
                barcodeOwners.set(value.barcode, owners);
            }
            parsed.push({ rowNumber, value });
        });

        // A barcode on more than one SKU is not fatal — the scan endpoint asks
        // the user which item they are holding — but the buyer should see it.
        const sharedBarcodes = [...barcodeOwners.entries()]
            .filter(([, skus]) => skus.length > 1)
            .map(([barcode, skus]) => ({ barcode, skus }));

        const badChecksums = parsed
            .filter(p => p.value.barcode && p.value.barcode_checksum_ok === false)
            .map(p => ({ sku: p.value.sku, barcode: p.value.barcode_raw }));

        const stats = {
            rows_read: rows.length,
            rows_valid: parsed.length,
            products_new: 0,
            products_updated: 0,
            price_changes: 0,
            barcodes_new: 0,
            levels_seeded: 0,
            opening_balances: 0,
            skipped_no_price: 0
        };
        const sampleChanges = [];

        // ---- Existing state, fetched in bulk rather than row by row ----------
        const skus = parsed.map(p => p.value.sku);
        const existingBySku = new Map();
        for (const chunk of chunked(skus, 200)) {
            const { data } = await supabaseAdmin
                .from('products')
                .select('id, sku, price, name')
                .eq('company_id', companyId)
                .in('sku', chunk);
            for (const p of data || []) existingBySku.set(p.sku, p);
        }

        // ---- Apply -----------------------------------------------------------
        for (const { value } of parsed) {
            const existing = existingBySku.get(value.sku) || null;

            const productRow = {
                company_id: companyId,
                sku: value.sku,
                name: value.name,
                brand: value.brand,
                category: value.category,
                is_active: true,
                metadata: {
                    sub_category: value.sub_category || null,
                    vendor_item_number: value.vendor_item_number || null,
                    master_file_notes: value.notes || null
                }
            };
            if (value.price !== null) productRow.price = value.price;
            if (value.case_qty !== null) productRow.case_qty = value.case_qty;
            if (value.unit) productRow.unit = value.unit;

            let productId = existing?.id || null;

            if (existing) {
                if (value.price !== null && Math.round(Number(existing.price) * 100) !== Math.round(value.price * 100)) {
                    stats.price_changes++;
                    if (sampleChanges.length < 20) {
                        sampleChanges.push({ sku: value.sku, name: value.name, old_price: Number(existing.price), new_price: value.price });
                    }
                }
                stats.products_updated++;
                if (!dryRun) {
                    await supabaseAdmin.from('products')
                        .update({ ...productRow, updated_at: new Date().toISOString() })
                        .eq('id', existing.id);
                }
            } else {
                // products.price is NOT NULL, so a new item with no usable price
                // in the file cannot be created. Report it rather than guessing.
                if (value.price === null) {
                    stats.skipped_no_price++;
                    errors.push({ row: null, error: `New item "${value.sku}" has no price and was skipped.` });
                    continue;
                }
                stats.products_new++;
                if (!dryRun) {
                    const { data: created, error: createErr } = await supabaseAdmin
                        .from('products').insert(productRow).select('id').single();
                    if (createErr) {
                        errors.push({ row: null, error: `Could not create "${value.sku}": ${createErr.message}` });
                        continue;
                    }
                    productId = created.id;
                }
            }

            // ---- Barcode ----
            if (value.barcode && (productId || dryRun)) {
                if (dryRun) {
                    stats.barcodes_new++;
                } else {
                    const { data: existingBarcode } = await supabaseAdmin
                        .from('product_barcodes')
                        .select('id')
                        .eq('product_id', productId)
                        .eq('barcode', value.barcode)
                        .maybeSingle();
                    if (!existingBarcode) {
                        const { error: bcErr } = await supabaseAdmin.from('product_barcodes').insert({
                            product_id: productId,
                            barcode: value.barcode,
                            symbology: value.barcode_symbology || detectSymbology(value.barcode),
                            is_primary: false,
                            source: 'master_file'
                        });
                        if (!bcErr) stats.barcodes_new++;
                    }
                }
            }

            // ---- Per-location level ----
            if (mode === 'seed' && (productId || dryRun)) {
                stats.levels_seeded++;
                if (!dryRun) {
                    const levelRow = {
                        company_id: companyId,
                        location_id: location.id,
                        product_id: productId,
                        min_point: value.min_point ?? null,
                        max_point: value.max_point ?? null,
                        reorder_qty: value.reorder_qty ?? null,
                        bin_location: value.bin_location ?? null,
                        updated_at: new Date().toISOString()
                    };
                    await supabaseAdmin
                        .from('inventory_levels')
                        .upsert(levelRow, { onConflict: 'location_id,product_id', ignoreDuplicates: false });

                    // An opening balance goes through the ledger like every other
                    // stock change, so the audit trail starts at the beginning.
                    if (value.on_hand !== undefined && Number(value.on_hand) !== 0) {
                        const { data: current } = await supabaseAdmin
                            .from('inventory_levels')
                            .select('on_hand')
                            .eq('location_id', location.id).eq('product_id', productId)
                            .maybeSingle();
                        const delta = Number(value.on_hand) - Number(current?.on_hand ?? 0);
                        if (delta !== 0) {
                            await supabaseAdmin.from('stock_movements').insert({
                                company_id: companyId,
                                location_id: location.id,
                                product_id: productId,
                                qty_change: delta,
                                movement_type: 'seed',
                                reason: `Opening balance from ${req.file.originalname}`,
                                source_doc_type: 'master_upload',
                                actor_type: 'admin',
                                actor_label: req.admin.email,
                                created_by: req.admin.id
                            });
                            stats.opening_balances++;
                        }
                    }
                }
            }
        }

        // ---- Record the upload ----------------------------------------------
        if (!dryRun) {
            await supabaseAdmin.from('inventory_uploads').insert({
                company_id: companyId,
                location_id: location?.id || null,
                admin_id: req.admin.id,
                filename: req.file.originalname,
                file_type: ext,
                mode,
                row_count: stats.rows_read,
                products_new: stats.products_new,
                products_upd: stats.products_updated,
                barcodes_new: stats.barcodes_new,
                levels_seeded: stats.levels_seeded,
                status: errors.length ? 'completed_with_errors' : 'completed',
                error_details: errors.slice(0, 200)
            });

            await logAction(req.admin.id, 'inventory_master_uploaded', 'company', companyId, {
                filename: req.file.originalname, mode, location: location?.name || null, ...stats, errors: errors.length
            }, req.ip);
        }

        res.json({
            preview: dryRun,
            message: dryRun
                ? 'Preview only — nothing was written.'
                : `Master file imported${mode === 'seed' ? ` into ${location.name}` : ''}.`,
            mode,
            location: location ? { id: location.id, name: location.name } : null,
            ...stats,
            errors: errors.length,
            error_details: errors.slice(0, 25),
            sample_changes: sampleChanges,
            shared_barcodes: sharedBarcodes.slice(0, 25),
            shared_barcode_count: sharedBarcodes.length,
            invalid_check_digits: badChecksums.slice(0, 25),
            invalid_check_digit_count: badChecksums.length
        });
    } catch (err) {
        console.error('Inventory master upload error:', err);
        res.status(500).json({ error: 'Failed to process that file.' });
    }
});

function* chunked(arr, size) {
    for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}

// ============================================================
// BARCODES
// ============================================================

/** GET /api/admin/companies/:companyId/inventory/barcodes?product_id= */
router.get('/barcodes', async (req, res) => {
    try {
        const companyId = req.params.companyId;
        const productId = req.query.product_id;
        if (!isValidUUID(productId)) return res.status(400).json({ error: 'A product is required.' });

        const { data: product } = await supabaseAdmin
            .from('products').select('id, name, sku').eq('id', productId).eq('company_id', companyId).maybeSingle();
        if (!product) return res.status(404).json({ error: 'Product not found for this company.' });

        const { data, error } = await supabaseAdmin
            .from('product_barcodes')
            .select('id, barcode, symbology, is_primary, source, created_at')
            .eq('product_id', productId)
            .order('is_primary', { ascending: false })
            .order('created_at');
        if (error) throw error;

        res.json({ product, barcodes: data || [] });
    } catch (err) {
        console.error('Barcode list error:', err);
        res.status(500).json({ error: 'Failed to load barcodes.' });
    }
});

/**
 * POST /api/admin/companies/:companyId/inventory/barcodes
 * Body: { product_id, barcode, symbology?, is_primary? }
 *
 * Used both to attach a manufacturer UPC and to register an internal label for
 * decanted paint, kits and private-label items that have no UPC of their own.
 */
router.post('/barcodes', async (req, res) => {
    try {
        const companyId = req.params.companyId;
        const productId = req.body?.product_id;
        if (!isValidUUID(productId)) return res.status(400).json({ error: 'A product is required.' });

        const { data: product } = await supabaseAdmin
            .from('products').select('id, sku, name').eq('id', productId).eq('company_id', companyId).maybeSingle();
        if (!product) return res.status(404).json({ error: 'Product not found for this company.' });

        const barcode = canonicalBarcode(req.body?.barcode);
        if (!barcode || barcode.length < 4) {
            return res.status(400).json({ error: 'Enter a barcode of at least 4 characters.' });
        }
        if (barcode.length > 128) return res.status(400).json({ error: 'That barcode is too long.' });

        // Warn when the code already points at a different item in this company.
        const { data: clashes } = await supabaseAdmin
            .from('product_barcodes')
            .select('product_id, products!inner(sku, name, company_id)')
            .in('barcode', barcodeVariants(barcode))
            .eq('products.company_id', companyId)
            .neq('product_id', productId)
            .limit(5);

        const isPrimary = !!req.body?.is_primary;
        if (isPrimary) {
            await supabaseAdmin.from('product_barcodes')
                .update({ is_primary: false }).eq('product_id', productId).eq('is_primary', true);
        }

        const { data, error } = await supabaseAdmin
            .from('product_barcodes')
            .upsert({
                product_id: productId,
                barcode,
                symbology: detectSymbology(barcode),
                is_primary: isPrimary,
                source: 'manual'
            }, { onConflict: 'product_id,barcode' })
            .select()
            .single();
        if (error) throw error;

        await logAction(req.admin.id, 'barcode_added', 'product', productId, { barcode, sku: product.sku }, req.ip);

        res.status(201).json({
            barcode: data,
            warning: clashes && clashes.length
                ? `This code is also on ${clashes.map(c => c.products.sku || c.products.name).join(', ')} — scans will ask the user which item they mean.`
                : null
        });
    } catch (err) {
        console.error('Barcode create error:', err);
        res.status(500).json({ error: 'Failed to save that barcode.' });
    }
});

/** DELETE /api/admin/companies/:companyId/inventory/barcodes/:id */
router.delete('/barcodes/:id', async (req, res) => {
    try {
        const companyId = req.params.companyId;
        if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid barcode id.' });

        const { data: row } = await supabaseAdmin
            .from('product_barcodes')
            .select('id, barcode, product_id, products!inner(company_id, sku)')
            .eq('id', req.params.id)
            .maybeSingle();

        if (!row || row.products.company_id !== companyId) {
            return res.status(404).json({ error: 'Barcode not found for this company.' });
        }

        const { error } = await supabaseAdmin.from('product_barcodes').delete().eq('id', req.params.id);
        if (error) throw error;

        await logAction(req.admin.id, 'barcode_removed', 'product', row.product_id,
            { barcode: row.barcode, sku: row.products.sku }, req.ip);
        res.json({ message: 'Barcode removed.' });
    } catch (err) {
        console.error('Barcode delete error:', err);
        res.status(500).json({ error: 'Failed to remove that barcode.' });
    }
});

// ============================================================
// OVERSIGHT
// ============================================================

/**
 * GET /api/admin/companies/:companyId/inventory/levels
 * Every tracked level across the company, or one location. Supports ?format=csv.
 */
router.get('/levels', async (req, res) => {
    try {
        const companyId = req.params.companyId;
        const { location_id, status, search, limit = 500 } = req.query;

        let query = supabaseAdmin
            .from('inventory_status')
            .select('*', { count: 'exact' })
            .eq('company_id', companyId);

        if (location_id && isValidUUID(location_id)) query = query.eq('location_id', location_id);
        if (status && ['low', 'out', 'ok', 'untracked'].includes(status)) query = query.eq('stock_status', status);
        if (search) {
            const term = String(search).replace(/[%,()]/g, '').slice(0, 60);
            if (term) query = query.or(`product_name.ilike.%${term}%,sku.ilike.%${term}%,brand.ilike.%${term}%`);
        }

        const cap = req.query.format === 'csv' ? 20000 : Math.min(2000, parseInt(limit) || 500);
        query = query.order('location_name').order('product_name').limit(cap);

        const { data, error, count } = await query;
        if (error) throw error;

        if (req.query.format === 'csv') {
            const header = ['Location', 'SKU', 'Product', 'Brand', 'Category', 'On hand', 'Min', 'Max', 'Bin', 'Status', 'Suggested order'];
            const lines = [header.join(',')];
            for (const r of data || []) {
                lines.push([
                    r.location_name, r.sku, r.product_name, r.brand, r.category,
                    r.on_hand, r.min_point ?? '', r.max_point ?? '', r.bin_location ?? '',
                    r.stock_status, r.suggested_order_qty
                ].map(csvCell).join(','));
            }
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="inventory-${companyId}.csv"`);
            return res.send(lines.join('\n'));
        }

        res.json({ levels: data || [], total: count || 0 });
    } catch (err) {
        console.error('Admin inventory levels error:', err);
        res.status(500).json({ error: 'Failed to load stock levels.' });
    }
});

function csvCell(v) {
    const s = String(v === null || v === undefined ? '' : v);
    // Neutralise spreadsheet formula injection on export.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** GET /api/admin/companies/:companyId/inventory/low-stock — feeds the alert email. */
router.get('/low-stock', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('inventory_status')
            .select('location_id, location_name, sku, product_name, brand, on_hand, min_point, max_point, suggested_order_qty, stock_status')
            .eq('company_id', req.params.companyId)
            .in('stock_status', ['low', 'out'])
            .order('location_name').order('product_name')
            .limit(1000);
        if (error) throw error;

        const byLocation = {};
        for (const row of data || []) {
            byLocation[row.location_name] = byLocation[row.location_name] || [];
            byLocation[row.location_name].push(row);
        }
        res.json({ count: (data || []).length, by_location: byLocation, items: data || [] });
    } catch (err) {
        console.error('Low stock error:', err);
        res.status(500).json({ error: 'Failed to load low-stock items.' });
    }
});

/** GET /api/admin/companies/:companyId/inventory/movements — the full audit trail. */
router.get('/movements', async (req, res) => {
    try {
        const companyId = req.params.companyId;
        const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit) || 200));

        let query = supabaseAdmin
            .from('stock_movements')
            .select('id, location_id, product_id, qty_change, movement_type, reason, job_ref, scanned_barcode, actor_type, actor_label, on_hand_after, created_at, products(sku, name, brand), company_locations(name)')
            .eq('company_id', companyId)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (req.query.location_id && isValidUUID(req.query.location_id)) query = query.eq('location_id', req.query.location_id);
        if (req.query.product_id && isValidUUID(req.query.product_id)) query = query.eq('product_id', req.query.product_id);
        if (req.query.movement_type && MOVEMENT_TYPE_NAMES.includes(req.query.movement_type)) {
            query = query.eq('movement_type', req.query.movement_type);
        }
        if (req.query.from) query = query.gte('created_at', new Date(req.query.from).toISOString());
        if (req.query.to) query = query.lte('created_at', new Date(req.query.to).toISOString());

        const { data, error } = await query;
        if (error) throw error;
        res.json({ movements: data || [] });
    } catch (err) {
        console.error('Admin movements error:', err);
        res.status(500).json({ error: 'Failed to load movement history.' });
    }
});

/** GET /api/admin/companies/:companyId/inventory/replenishment — every queue, all statuses. */
router.get('/replenishment', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('replenishment_orders')
            .select('id, location_id, status, notes, created_by_label, approved_by_label, decision_reason, order_id, po_number, created_at, approved_at, rejected_at, company_locations(name), replenishment_order_lines(id, sku, name, quantity, unit_price, on_hand_at_draft, source)')
            .eq('company_id', req.params.companyId)
            .order('created_at', { ascending: false })
            .limit(100);
        if (error) throw error;
        res.json({ orders: data || [] });
    } catch (err) {
        console.error('Admin replenishment error:', err);
        res.status(500).json({ error: 'Failed to load replenishment orders.' });
    }
});

/**
 * POST /api/admin/companies/:companyId/inventory/adjust
 * A CHC-side correction, posted through the ledger like any other movement.
 * Body: { location_id, product_id, movement_type, quantity, reason (required) }
 */
router.post('/adjust', async (req, res) => {
    try {
        const companyId = req.params.companyId;
        const location = await resolveLocation(companyId, req.body?.location_id);
        if (!location) return res.status(400).json({ error: 'A valid location is required.' });

        const productId = req.body?.product_id;
        if (!isValidUUID(productId)) return res.status(400).json({ error: 'A valid product is required.' });

        const { data: product } = await supabaseAdmin
            .from('products').select('id, sku, name').eq('id', productId).eq('company_id', companyId).maybeSingle();
        if (!product) return res.status(404).json({ error: 'Product not found for this company.' });

        const reason = text(req.body?.reason, 300);
        if (!reason) return res.status(400).json({ error: 'A reason is required for an adjustment.' });

        const movementType = String(req.body?.movement_type || 'adjust');
        if (!MOVEMENT_TYPE_NAMES.includes(movementType)) {
            return res.status(400).json({ error: 'Unsupported movement type.' });
        }

        const { data: level } = await supabaseAdmin
            .from('inventory_levels').select('on_hand')
            .eq('location_id', location.id).eq('product_id', productId).maybeSingle();

        const delta = movementDelta(movementType, req.body?.quantity, Number(level?.on_hand ?? 0));
        if (!delta.ok) return res.status(400).json({ error: delta.error });

        const { data, error } = await supabaseAdmin
            .from('stock_movements')
            .insert({
                company_id: companyId,
                location_id: location.id,
                product_id: productId,
                qty_change: delta.delta,
                movement_type: movementType,
                reason,
                source_doc_type: 'admin_adjust',
                actor_type: 'admin',
                actor_label: req.admin.email,
                created_by: req.admin.id
            })
            .select('id, qty_change, on_hand_after, created_at')
            .single();
        if (error) throw error;

        await logAction(req.admin.id, 'inventory_adjusted', 'product', productId, {
            location: location.name, sku: product.sku, qty_change: delta.delta, reason
        }, req.ip);

        res.status(201).json({ message: 'Adjustment recorded.', movement: data, on_hand: Number(data.on_hand_after) });
    } catch (err) {
        console.error('Admin adjust error:', err);
        res.status(500).json({ error: 'Failed to record that adjustment.' });
    }
});

/**
 * POST /api/admin/companies/:companyId/inventory/recompute
 * Rebuild on-hand from the ledger. The trigger keeps them in step, so this is a
 * reconciliation tool for after a data import or a manual database edit.
 */
router.post('/recompute', async (req, res) => {
    try {
        const companyId = req.params.companyId;
        const locationId = req.body?.location_id && isValidUUID(req.body.location_id) ? req.body.location_id : null;

        const { data, error } = await supabaseAdmin.rpc('recompute_inventory_on_hand', {
            p_company_id: companyId,
            p_location_id: locationId
        });
        if (error) throw error;

        await logAction(req.admin.id, 'inventory_recomputed', 'company', companyId,
            { location_id: locationId, rows_corrected: data }, req.ip);

        res.json({ message: `${data || 0} level${data === 1 ? '' : 's'} corrected.`, corrected: data || 0 });
    } catch (err) {
        console.error('Recompute error:', err);
        res.status(500).json({ error: 'Failed to recompute on-hand quantities.' });
    }
});

// ============================================================
// LOW-STOCK ALERTS (phase 5)
// ============================================================

/**
 * POST /api/admin/companies/:companyId/inventory/alerts/low-stock
 * Body: { dry_run?: bool, force?: bool, store_url?: string }
 *
 * Sends one digest per company covering every location. Designed to be called
 * by a scheduler once a morning; safe to call more than once because the
 * fingerprint check below suppresses an identical digest sent the same day.
 * Set force to override that, e.g. when re-sending after fixing a bad address.
 */
router.post('/alerts/low-stock', async (req, res) => {
    try {
        const companyId = req.params.companyId;
        const company = await loadCompany(companyId);
        if (!company) return res.status(404).json({ error: 'Company not found.' });

        const settings = inventorySettings(company.settings);
        if (!settings.enabled) {
            return res.status(403).json({ error: 'refinishAI Inventory is not enabled for this account.' });
        }

        const { data: items, error } = await supabaseAdmin
            .from('inventory_status')
            .select('location_id, location_name, sku, product_name, brand, on_hand, min_point, max_point, suggested_order_qty, stock_status')
            .eq('company_id', companyId)
            .in('stock_status', ['low', 'out'])
            .order('location_name').order('product_name')
            .limit(1000);
        if (error) throw error;

        const rows = items || [];
        if (!rows.length) {
            return res.json({ sent: false, reason: 'nothing_to_report', count: 0,
                message: 'Nothing is below its minimum — no digest sent.' });
        }

        // Recipients: the company contact, its manager group, and any extra
        // addresses configured for inventory specifically.
        const { data: full } = await supabaseAdmin
            .from('companies').select('name, contact_email, email_config').eq('id', companyId).single();
        const cfg = full?.email_config || {};
        const recipients = validEmails([
            ...(full?.contact_email ? [full.contact_email] : []),
            ...(Array.isArray(cfg.manager_emails) ? cfg.manager_emails : []),
            ...settings.alert_emails
        ]);

        if (!recipients.length) {
            return res.status(400).json({
                error: 'No recipients configured. Add a company contact, manager emails, or inventory alert emails.'
            });
        }

        const byLocation = {};
        for (const row of rows) {
            const key = row.location_name || 'Unassigned';
            (byLocation[key] = byLocation[key] || []).push(row);
        }

        // Fingerprint the digest so a scheduler that fires twice, or a retry
        // after a transient failure, does not send the same list again.
        const fingerprint = crypto.createHash('sha256')
            .update(rows.map(r => `${r.location_id}:${r.sku}:${r.on_hand}`).join('|'))
            .digest('hex').slice(0, 32);

        if (!req.body?.force) {
            const since = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
            const { data: recent } = await supabaseAdmin
                .from('inventory_alert_log')
                .select('id, sent_at')
                .eq('company_id', companyId)
                .eq('alert_type', 'low_stock')
                .eq('fingerprint', fingerprint)
                .gte('sent_at', since)
                .maybeSingle();
            if (recent) {
                return res.json({
                    sent: false, reason: 'already_sent', count: rows.length,
                    message: 'An identical digest went out in the last 20 hours. Pass force to send it again.',
                    last_sent_at: recent.sent_at
                });
            }
        }

        if (req.body?.dry_run) {
            return res.json({
                sent: false, preview: true, count: rows.length,
                recipients, locations: Object.keys(byLocation),
                message: `Would send to ${recipients.length} recipient(s).`
            });
        }

        const result = await sendLowStockAlert({
            to: recipients,
            companyName: full?.name || company.name,
            byLocation,
            count: rows.length,
            storeUrl: text(req.body?.store_url, 300) || null
        });

        if (result.sent) {
            await supabaseAdmin.from('inventory_alert_log').insert({
                company_id: companyId,
                alert_type: 'low_stock',
                item_count: rows.length,
                recipients,
                fingerprint
            });
            await logAction(req.admin.id, 'low_stock_alert_sent', 'company', companyId,
                { count: rows.length, recipients: recipients.length }, req.ip);
        }

        res.json({ ...result, count: rows.length, locations: Object.keys(byLocation) });
    } catch (err) {
        console.error('Low-stock alert error:', err);
        res.status(500).json({ error: 'Failed to send the low-stock digest.' });
    }
});

/** GET /alerts/log — when digests went out, and to whom. */
router.get('/alerts/log', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('inventory_alert_log')
            .select('id, alert_type, item_count, recipients, sent_at')
            .eq('company_id', req.params.companyId)
            .order('sent_at', { ascending: false })
            .limit(50);
        if (error) throw error;
        res.json({ alerts: data || [] });
    } catch (err) {
        console.error('Alert log error:', err);
        res.status(500).json({ error: 'Failed to load the alert log.' });
    }
});

// ============================================================
// MASTER-CATALOG GOVERNANCE (phase 4)
// ============================================================

/**
 * POST /api/admin/companies/:companyId/inventory/govern
 * Body: { skus: string[], dry_run?: bool, reason? }
 *
 * Constrain a company to a named SKU set: anything active that is not on the
 * list is deactivated. Deactivated, never deleted — a product with order or
 * ledger history has to stay resolvable for reporting, and a governance sweep
 * is not the place to destroy it.
 */
router.post('/govern', async (req, res) => {
    try {
        const companyId = req.params.companyId;
        const dryRun = !!req.body?.dry_run;

        const skus = Array.isArray(req.body?.skus) ? req.body.skus : null;
        if (!skus || !skus.length) {
            return res.status(400).json({ error: 'Supply the list of SKUs the company is allowed to stock.' });
        }
        if (skus.length > 20000) {
            return res.status(400).json({ error: 'Maximum 20,000 SKUs per governance run.' });
        }

        const allowed = new Set(skus.map(s => String(s || '').trim()).filter(Boolean));

        const { data: active, error } = await supabaseAdmin
            .from('products')
            .select('id, sku, name, brand')
            .eq('company_id', companyId)
            .eq('is_active', true)
            .limit(20000);
        if (error) throw error;

        const offList = (active || []).filter(p => !allowed.has(String(p.sku || '').trim()));

        if (!dryRun && offList.length) {
            for (let i = 0; i < offList.length; i += 200) {
                const chunk = offList.slice(i, i + 200).map(p => p.id);
                await supabaseAdmin.from('products')
                    .update({ is_active: false, updated_at: new Date().toISOString() })
                    .in('id', chunk);
            }
            await logAction(req.admin.id, 'catalog_governed', 'company', companyId, {
                allowed: allowed.size, deactivated: offList.length, reason: text(req.body?.reason, 200)
            }, req.ip);
        }

        res.json({
            preview: dryRun,
            message: dryRun
                ? `${offList.length} active item${offList.length === 1 ? '' : 's'} are not on the master list.`
                : `${offList.length} item${offList.length === 1 ? '' : 's'} deactivated.`,
            allowed_skus: allowed.size,
            active_before: (active || []).length,
            deactivated: offList.length,
            sample: offList.slice(0, 50).map(p => ({ sku: p.sku, name: p.name, brand: p.brand }))
        });
    } catch (err) {
        console.error('Catalog governance error:', err);
        res.status(500).json({ error: 'Failed to apply catalog governance.' });
    }
});

module.exports = router;
