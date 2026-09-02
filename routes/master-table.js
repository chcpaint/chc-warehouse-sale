/**
 * routes/master-table.js
 *
 * The master table — maintaining item_library, rather than only reading it.
 *
 * Mounted from routes/admin.js at /api/admin/master.
 *
 * WHY THIS EXISTS
 * ---------------
 * item_library has held the canonical part number, name, brand and barcode
 * since migration 021, and the Item Library screen has always been able to
 * search it and add from it. What there was never a way to do was LOAD it.
 * It was populated once by hand, so a corrected master file had nowhere to
 * go and the library slowly drifted from the spreadsheet people actually
 * maintain. This is the way in.
 *
 * THE RULES THE IMPORT FOLLOWS
 * ----------------------------
 * - The file wins. Where the file and the library disagree on a name, brand,
 *   price or category, the file's value is written — and the old one is kept
 *   in item_library_changes so any overwrite can be seen and reversed. A
 *   "file wins" rule without that log is just data loss with a policy name.
 *
 * - A BLANK CELL IS NOT AN INSTRUCTION. An empty barcode column does not mean
 *   "delete the barcode we have"; it means the spreadsheet does not know one.
 *   Only non-empty values overwrite.
 *
 * - Two rows that normalise to the same key cannot both be stored, because
 *   sku_key is unique — that is what stops MMM-06652 and MMM06652 becoming
 *   two parts. The first is imported, the second is SKIPPED and reported by
 *   name, never silently dropped.
 *
 * - A barcode already carried by a different part is refused and logged as a
 *   conflict. Taking it would make a scan ambiguous, which is worse than a
 *   missing barcode: a missing one stops the picker, a wrong one doesn't.
 *
 * - Preview does not write. Every import can be run as a dry run first, and
 *   the preview and the apply share one code path so what you were shown is
 *   what happens.
 *
 * Super-admin only, enforced here rather than by hiding a menu item.
 */

const express = require('express');
const XLSX = require('xlsx');
const { supabaseAdmin } = require('../utils/supabase');
const { requireSuperAdmin } = require('../middleware/auth');
const { catalogUpload } = require('../middleware/upload');
const { stripHtml, isValidUUID } = require('../utils/sanitize');

const router = express.Router();

// The screen is fenced in the API, not only in the console. Hiding a nav item
// is presentation; this is the boundary.
router.use(requireSuperAdmin);

const PAGE = 1000;
const MAX_IMPORT_ROWS = 20000;

/**
 * The library's normalisation, repeated nowhere else. Every lookup in this
 * file, in item-library.js and in the SQL views strips the same characters,
 * so they cannot disagree about whether two spellings are the same part.
 */
function skuKey(sku) {
    return String(sku || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

const clean = v => {
    if (v === null || v === undefined) return '';
    const s = String(v).trim();
    // Spreadsheets say "not available" and "n/a" where they mean nothing. A
    // literal "n/a" stored as a barcode is worse than a null, because it looks
    // like data.
    if (/^(n\/?a|none|null|not available|-)$/i.test(s)) return '';
    return s;
};

const numOrNull = v => {
    const s = clean(v).replace(/[$,]/g, '');
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
};

/**
 * What unit does this barcode identify?
 *
 * A 14-digit GTIN is a carton code. Scanning it as though it were a single
 * item understates consumption by the case quantity, and nothing downstream
 * can detect that on its own — so it is recorded at import, where the length
 * is still visible.
 */
function barcodeLevel(code) {
    const c = clean(code);
    if (!c) return null;
    if (!/^\d+$/.test(c)) return 'unknown';
    if (c.length === 14) return 'case';
    if ([8, 12, 13].includes(c.length)) return 'each';
    return 'unknown';
}

/**
 * Column names differ between the versions of this spreadsheet people keep.
 * Match on what the header means rather than on an exact string, so a file
 * with "UPC" and one with "UPC/Barcode" both load without anyone editing it.
 */
const FIELD_PATTERNS = [
    ['sku',          /^(item\s*number|part\s*#|part\s*number|sku|matched\s*part)/i],
    ['name',         /^(item\s*name|description|product\s*name|name)/i],
    ['category',     /^(product\s*category|category)/i],
    ['sub_category', /^(sub[\s-]*category)/i],
    ['brand',        /^(brand|manufacturer|vendor\s*name)/i],
    ['vendor_code',  /^(vendor\s*item|vendor\s*code|supplier\s*(item|code))/i],
    ['list_price',   /^(msrp|list\s*price|selling\s*price|price)/i],
    ['barcode',      /^(upc|barcode|ean|gtin|upc\/barcode)/i],
    ['case_qty',     /^(case\s*qty|case\s*quantity|qty\s*per\s*case|pack)/i],
    ['unit',         /^(unit|uom)/i],
    ['notes',        /^(notes?|comment)/i]
];

function mapHeaders(headerRow) {
    const map = {};
    headerRow.forEach((h, idx) => {
        const label = clean(h);
        if (!label) return;
        for (const [field, re] of FIELD_PATTERNS) {
            if (map[field] === undefined && re.test(label)) { map[field] = idx; return; }
        }
    });
    return map;
}

/**
 * Read the uploaded workbook into plain rows.
 *
 * The header is not assumed to be row 1: these files sometimes carry a title
 * or a blank line above it. The first row that yields a recognisable SKU
 * column is the header.
 */
function parseWorkbook(buffer, filename, wantedSheet) {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    const sheetName = wantedSheet && wb.SheetNames.includes(wantedSheet)
        ? wantedSheet
        : wb.SheetNames[0];
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, blankrows: false, raw: false });

    let headerIdx = -1, map = null;
    for (let i = 0; i < Math.min(grid.length, 10); i++) {
        const candidate = mapHeaders(grid[i] || []);
        if (candidate.sku !== undefined && candidate.name !== undefined) { headerIdx = i; map = candidate; break; }
    }
    if (headerIdx === -1) {
        const err = new Error(
            'Could not find a header row with a part number and an item name. ' +
            'The first ten rows were checked. Expected a column like "Item Number (Part #)" and one like "Item Name".');
        err.userFacing = true;
        throw err;
    }

    const rows = [];
    for (let i = headerIdx + 1; i < grid.length && rows.length < MAX_IMPORT_ROWS; i++) {
        const r = grid[i] || [];
        const get = f => (map[f] === undefined ? '' : clean(r[map[f]]));
        const sku = get('sku');
        if (!sku) continue;
        rows.push({
            row_number: i + 1,
            sku,
            sku_key: skuKey(sku),
            name: get('name'),
            category: get('category') || null,
            sub_category: get('sub_category') || null,
            brand: get('brand') || null,
            vendor_code: get('vendor_code') || null,
            list_price: numOrNull(get('list_price')),
            barcode: get('barcode') || null,
            case_qty: numOrNull(get('case_qty')),
            unit: get('unit') || null,
            notes: get('notes') || null
        });
    }
    return { sheetName, sheetNames: wb.SheetNames, rows, columns: Object.keys(map) };
}

/** Read every row of a table, a page at a time. */
async function readAll(build) {
    const out = [];
    for (let from = 0; from < 200000; from += PAGE) {
        const { data, error } = await build().range(from, from + PAGE - 1);
        if (error) throw error;
        const chunk = data || [];
        out.push(...chunk);
        if (chunk.length < PAGE) break;
    }
    return out;
}

// Fields the file may overwrite, and the column each lives in.
const IMPORTABLE = ['name', 'brand', 'vendor_code', 'list_price', 'barcode', 'case_qty', 'unit', 'category', 'sub_category', 'notes'];

const sameValue = (a, b) => {
    if (a === null || a === undefined || a === '') return b === null || b === undefined || b === '';
    if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
    return String(a) === String(b);
};

/**
 * Work out what a load would do, without doing it.
 *
 * Returns the plan AND the change rows. Apply then executes the plan rather
 * than recomputing it, so a preview and the load that follows cannot differ.
 */
async function planImport(rows) {
    const existing = await readAll(() => supabaseAdmin
        .from('item_library')
        .select('id, sku, sku_key, name, brand, vendor_code, barcode, unit, case_qty, list_price, category, sub_category, notes'));

    const bySkuKey = new Map(existing.map(r => [r.sku_key, r]));
    // Which part currently owns each barcode. Used to refuse a code that would
    // make a scan ambiguous.
    const barcodeOwner = new Map();
    for (const r of existing) if (r.barcode) barcodeOwner.set(String(r.barcode), r.sku_key);

    const seenInFile = new Map();
    const plan = { create: [], update: [], unchanged: 0 };
    const changes = [];

    for (const row of rows) {
        if (!row.sku_key) {
            changes.push({ sku_key: '', sku: row.sku, action: 'skipped',
                reason: `Row ${row.row_number}: the part number is empty once punctuation is removed.` });
            continue;
        }
        if (!row.name) {
            changes.push({ sku_key: row.sku_key, sku: row.sku, action: 'skipped',
                reason: `Row ${row.row_number}: no item name. A part with no name cannot be looked up or reported on.` });
            continue;
        }
        // Two file rows that normalise to the same key. Only one can be stored;
        // say which one lost and to what, because these are usually a real
        // product difference the part numbers fail to express (a gallon and a
        // quart distinguished only by a trailing dot).
        if (seenInFile.has(row.sku_key)) {
            const first = seenInFile.get(row.sku_key);
            changes.push({ sku_key: row.sku_key, sku: row.sku, action: 'skipped',
                reason: `Row ${row.row_number}: "${row.sku}" becomes the same key as "${first.sku}" (row ${first.row_number}) once punctuation and case are removed. Only one can be stored — give them distinct part numbers.` });
            continue;
        }
        seenInFile.set(row.sku_key, row);

        const current = bySkuKey.get(row.sku_key);

        // A barcode already on a different part is refused, not taken.
        let barcode = row.barcode;
        let barcodeRefused = null;
        if (barcode) {
            const owner = barcodeOwner.get(String(barcode));
            if (owner && owner !== row.sku_key) {
                barcodeRefused = owner;
                barcode = null;
            }
        }
        if (barcodeRefused) {
            changes.push({ sku_key: row.sku_key, sku: row.sku, action: 'conflict', field: 'barcode',
                new_value: String(row.barcode),
                reason: `Barcode ${row.barcode} is already on ${barcodeRefused}. Left off this part rather than pointing one code at two items — a scan could not tell them apart.` });
        }

        const incoming = {
            name: row.name,
            brand: row.brand,
            vendor_code: row.vendor_code,
            list_price: row.list_price,
            barcode,
            case_qty: row.case_qty,
            unit: row.unit,
            category: row.category,
            sub_category: row.sub_category,
            notes: row.notes
        };

        if (!current) {
            plan.create.push({ sku: row.sku, sku_key: row.sku_key, ...incoming,
                barcode_level: barcodeLevel(barcode), source: 'master_import' });
            changes.push({ sku_key: row.sku_key, sku: row.sku, action: 'created',
                reason: barcode ? null : 'No barcode in the file for this part.' });
            if (barcode) barcodeOwner.set(String(barcode), row.sku_key);
            continue;
        }

        // File wins — but only where the file actually says something. A blank
        // cell is the spreadsheet not knowing, not an instruction to erase.
        const patch = {};
        for (const f of IMPORTABLE) {
            const v = incoming[f];
            if (v === null || v === undefined || v === '') continue;
            if (sameValue(current[f], v)) continue;
            patch[f] = v;
            changes.push({ sku_key: row.sku_key, sku: row.sku, action: 'updated', field: f,
                old_value: current[f] === null || current[f] === undefined ? null : String(current[f]),
                new_value: String(v) });
        }
        if (patch.barcode) {
            patch.barcode_level = barcodeLevel(patch.barcode);
            barcodeOwner.set(String(patch.barcode), row.sku_key);
        }
        // Backfill the level for a barcode that was already there before this
        // column existed, without counting it as a change the file made.
        if (!patch.barcode && current.barcode && !current.barcode_level) {
            patch.barcode_level = barcodeLevel(current.barcode);
        }

        if (Object.keys(patch).length === 0) plan.unchanged += 1;
        else plan.update.push({ id: current.id, sku: row.sku, sku_key: row.sku_key, patch });
    }

    return { plan, changes };
}

function summarise(plan, changes, rowCount) {
    return {
        rows_in_file: rowCount,
        to_create: plan.create.length,
        to_update: plan.update.length,
        unchanged: plan.unchanged,
        skipped: changes.filter(c => c.action === 'skipped').length,
        barcode_conflicts: changes.filter(c => c.action === 'conflict').length,
        field_changes: changes.filter(c => c.action === 'updated').length,
        // Coverage the file would leave behind — the number that says how much
        // scanning will actually work.
        barcodes_in_file: plan.create.filter(c => c.barcode).length
                        + plan.update.filter(u => u.patch.barcode).length
    };
}

/**
 * POST /api/admin/master/import
 *   multipart: file
 *   ?apply=true   — write. Omit for a dry run.
 *   ?sheet=NAME   — which worksheet, when the workbook has several.
 */
router.post('/import', catalogUpload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file was uploaded.' });

        let parsed;
        try {
            parsed = parseWorkbook(req.file.buffer, req.file.originalname, req.query.sheet);
        } catch (e) {
            if (e.userFacing) return res.status(400).json({ error: e.message });
            throw e;
        }
        if (!parsed.rows.length) {
            return res.status(400).json({ error: 'That sheet has a header but no rows with a part number.',
                                          sheets: parsed.sheetNames });
        }

        const { plan, changes } = await planImport(parsed.rows);
        const summary = summarise(plan, changes, parsed.rows.length);
        const apply = String(req.query.apply) === 'true';

        // The ledger records previews too. A load that was looked at and not
        // run is part of the story of how the catalogue got the way it is.
        const { data: batch, error: batchErr } = await supabaseAdmin
            .from('item_library_imports')
            .insert({
                filename: stripHtml(req.file.originalname || '').slice(0, 200),
                sheet_name: parsed.sheetName,
                rows_in_file: parsed.rows.length,
                created_count: apply ? plan.create.length : 0,
                updated_count: apply ? plan.update.length : 0,
                unchanged_count: plan.unchanged,
                skipped_count: summary.skipped,
                field_changes: apply ? summary.field_changes : 0,
                applied: apply,
                imported_by: req.admin.id,
                notes: apply ? null : 'Preview only — nothing was written.'
            })
            .select().single();
        if (batchErr) throw batchErr;

        if (!apply) {
            return res.json({
                applied: false,
                import_id: batch.id,
                sheet: parsed.sheetName,
                sheets: parsed.sheetNames,
                columns_found: parsed.columns,
                summary,
                // Everything that will NOT simply work, in full. These are the
                // rows a person has to make a decision about, so they are never
                // truncated away.
                problems: changes.filter(c => c.action === 'skipped' || c.action === 'conflict'),
                sample_changes: changes.filter(c => c.action === 'updated').slice(0, 100)
            });
        }

        // ---- write ----
        let created = 0, updated = 0;
        for (let i = 0; i < plan.create.length; i += 200) {
            const slice = plan.create.slice(i, i + 200);
            const { error } = await supabaseAdmin.from('item_library').insert(slice);
            if (error) throw error;
            created += slice.length;
        }
        for (const u of plan.update) {
            const { error } = await supabaseAdmin.from('item_library')
                .update({ ...u.patch, updated_at: new Date().toISOString() })
                .eq('id', u.id);
            if (error) throw error;
            updated += 1;
        }

        // The change log is written last and in bulk. If it fails the data is
        // already correct; an import with no log is recoverable, a log with no
        // import is a lie.
        const logRows = changes.map(c => ({
            import_id: batch.id, sku_key: c.sku_key, sku: c.sku, action: c.action,
            field: c.field || null, old_value: c.old_value || null,
            new_value: c.new_value || null, reason: c.reason || null
        }));
        for (let i = 0; i < logRows.length; i += 500) {
            const { error } = await supabaseAdmin.from('item_library_changes').insert(logRows.slice(i, i + 500));
            if (error) console.error('Change log write failed (import already applied):', error.message);
        }

        await supabaseAdmin.from('audit_log').insert({
            admin_id: req.admin.id, action: 'master_table_imported',
            entity_type: 'item_library', entity_id: batch.id,
            details: { ...summary, filename: req.file.originalname, sheet: parsed.sheetName },
            ip_address: req.ip
        }).then(() => {}, () => {});

        res.json({ applied: true, import_id: batch.id, sheet: parsed.sheetName,
                   summary: { ...summary, created, updated },
                   problems: changes.filter(c => c.action === 'skipped' || c.action === 'conflict') });

    } catch (err) {
        console.error('Master import error:', err);
        res.status(500).json({ error: 'The import failed. Nothing partial was left behind unless the message above says otherwise.' });
    }
});

/**
 * GET /api/admin/master?q=&limit=&offset=&missing_barcode=true
 * Search the master table itself.
 */
router.get('/', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 500);
        const offset = Math.max(parseInt(req.query.offset) || 0, 0);
        let q = supabaseAdmin.from('item_library')
            .select('id, sku, sku_key, name, brand, category, sub_category, barcode, barcode_level, unit, case_qty, list_price, is_active, updated_at',
                    { count: 'exact' });

        const term = clean(req.query.q);
        if (term) {
            const key = skuKey(term);
            // A scanned barcode, a part number in any spelling, or words from
            // the name all arrive in the same box — so try all three rather
            // than making the user pick a search mode.
            q = q.or(`sku_key.ilike.%${key}%,barcode.ilike.%${term}%,name.ilike.%${term}%`);
        }
        if (String(req.query.missing_barcode) === 'true') q = q.is('barcode', null);
        if (clean(req.query.category)) q = q.eq('category', clean(req.query.category));

        const { data, error, count } = await q.order('sku').range(offset, offset + limit - 1);
        if (error) throw error;
        res.json({ items: data || [], total: count || 0, limit, offset });
    } catch (err) {
        console.error('Master search error:', err);
        res.status(500).json({ error: 'Failed to search the master table.' });
    }
});

/** GET /api/admin/master/stats — the coverage numbers for the screen. */
router.get('/stats', async (req, res) => {
    try {
        const head = (t, build) => build(supabaseAdmin.from(t).select('id', { count: 'exact', head: true }));
        const [{ count: total }, { count: withBarcode }, { count: caseLevel }, { count: inactive }] = await Promise.all([
            head('item_library', q => q),
            head('item_library', q => q.not('barcode', 'is', null)),
            head('item_library', q => q.eq('barcode_level', 'case')),
            head('item_library', q => q.eq('is_active', false))
        ]);

        const { data: alignment } = await supabaseAdmin.from('v_catalogue_alignment')
            .select('company_id, company_name, products, matched_exact, matched_by_alias, proposed_aliases, unmatched, pct_resolved')
            .order('products', { ascending: false });

        const { data: imports } = await supabaseAdmin.from('item_library_imports')
            .select('id, filename, sheet_name, rows_in_file, created_count, updated_count, skipped_count, field_changes, applied, created_at')
            .order('created_at', { ascending: false }).limit(10);

        res.json({
            library: {
                items: total || 0,
                with_barcode: withBarcode || 0,
                without_barcode: (total || 0) - (withBarcode || 0),
                // Called out on its own because it is the one that silently
                // corrupts a count rather than stopping a scan.
                case_level_barcodes: caseLevel || 0,
                retired: inactive || 0,
                barcode_coverage_pct: total ? Math.round(1000 * (withBarcode || 0) / total) / 10 : 0
            },
            alignment: alignment || [],
            recent_imports: imports || []
        });
    } catch (err) {
        console.error('Master stats error:', err);
        res.status(500).json({ error: 'Failed to load master table stats.' });
    }
});

/** GET /api/admin/master/imports/:id/changes — what one load actually did. */
router.get('/imports/:id/changes', async (req, res) => {
    try {
        if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid import id.' });
        const limit = Math.min(parseInt(req.query.limit) || 200, 2000);
        let q = supabaseAdmin.from('item_library_changes')
            .select('sku, sku_key, action, field, old_value, new_value, reason, created_at', { count: 'exact' })
            .eq('import_id', req.params.id);
        if (clean(req.query.action)) q = q.eq('action', clean(req.query.action));
        const { data, error, count } = await q.order('sku').limit(limit);
        if (error) throw error;
        res.json({ changes: data || [], total: count || 0 });
    } catch (err) {
        console.error('Import changes error:', err);
        res.status(500).json({ error: 'Failed to load that import.' });
    }
});

/**
 * GET /api/admin/master/unmatched?company_id=
 * The products in a shop's catalogue that do not resolve to a master item —
 * the worklist for the crossover table.
 */
router.get('/unmatched', async (req, res) => {
    try {
        let q = supabaseAdmin.from('v_product_master')
            .select('product_id, company_id, company_name, company_sku, company_name_for_item, price, match_type')
            .eq('is_active', true)
            .in('match_type', ['unmatched', 'proposed']);
        if (req.query.company_id && isValidUUID(req.query.company_id)) q = q.eq('company_id', req.query.company_id);
        const { data, error } = await q.order('company_name').limit(2000);
        if (error) throw error;
        res.json({ products: data || [] });
    } catch (err) {
        console.error('Unmatched error:', err);
        res.status(500).json({ error: 'Failed to load unmatched products.' });
    }
});

/**
 * POST /api/admin/master/aliases
 * Map a shop's own part number or name to a master item.
 *
 * Created unapproved by design: a mapping CHC worked out is a proposal until
 * the customer confirms it, and reporting that must not be wrong can ask for
 * approved ones only. Merging two different parts in a customer's numbers is
 * the failure this guards against.
 */
router.post('/aliases', async (req, res) => {
    try {
        const companyId = req.body.company_id;
        if (!isValidUUID(companyId)) return res.status(400).json({ error: 'A valid company is required.' });

        const libKey = skuKey(req.body.library_sku || req.body.library_sku_key);
        if (!libKey) return res.status(400).json({ error: 'A master part number is required.' });

        const { data: master } = await supabaseAdmin.from('item_library')
            .select('sku_key, sku, name').eq('sku_key', libKey).maybeSingle();
        if (!master) return res.status(400).json({ error: `${req.body.library_sku} is not in the master table.` });

        const productId = req.body.product_id && isValidUUID(req.body.product_id) ? req.body.product_id : null;
        let aliasSku = clean(req.body.alias_sku);
        let aliasName = stripHtml(clean(req.body.alias_name)) || null;

        // When the alias was made from a real product row, take the shop's own
        // spelling from that product rather than trusting what was typed.
        if (productId) {
            const { data: prod } = await supabaseAdmin.from('products')
                .select('id, company_id, sku, name').eq('id', productId).maybeSingle();
            if (!prod) return res.status(400).json({ error: 'That product does not exist.' });
            if (prod.company_id !== companyId) {
                return res.status(400).json({ error: 'That product belongs to a different company.' });
            }
            if (!aliasSku) aliasSku = prod.sku;
            if (!aliasName) aliasName = prod.name;
        }
        if (!aliasSku && !productId) {
            return res.status(400).json({ error: 'Give either the customer\'s part number or the product it applies to.' });
        }

        const { data, error } = await supabaseAdmin.from('company_item_aliases')
            .insert({
                company_id: companyId,
                alias_sku: aliasSku || null,
                alias_sku_key: aliasSku ? skuKey(aliasSku) : null,
                alias_name: aliasName,
                library_sku_key: master.sku_key,
                product_id: productId,
                approved: false,
                source: 'chc',
                confidence: clean(req.body.confidence) || 'manual',
                created_by: req.admin.id,
                notes: stripHtml(clean(req.body.notes)) || null
            })
            .select().single();

        if (error) {
            if (error.code === '23505') {
                return res.status(409).json({ error: 'That mapping already exists for this customer.' });
            }
            throw error;
        }

        await supabaseAdmin.from('audit_log').insert({
            admin_id: req.admin.id, action: 'item_alias_created', entity_type: 'company_item_aliases',
            entity_id: data.id, details: { company_id: companyId, alias_sku: aliasSku, master: master.sku },
            ip_address: req.ip
        }).then(() => {}, () => {});

        res.status(201).json({ message: `Proposed: ${aliasSku || aliasName} means ${master.sku}. It counts in cross-shop reporting once the customer approves it.`, alias: data });
    } catch (err) {
        console.error('Alias create error:', err);
        res.status(500).json({ error: 'Failed to create that mapping.' });
    }
});

/** GET /api/admin/master/aliases?company_id=&approved= */
router.get('/aliases', async (req, res) => {
    try {
        let q = supabaseAdmin.from('company_item_aliases')
            .select('id, company_id, alias_sku, alias_name, library_sku_key, product_id, approved, approved_at, approved_by, source, confidence, created_at, notes');
        if (req.query.company_id && isValidUUID(req.query.company_id)) q = q.eq('company_id', req.query.company_id);
        if (req.query.approved === 'true') q = q.eq('approved', true);
        if (req.query.approved === 'false') q = q.eq('approved', false);
        const { data, error } = await q.order('created_at', { ascending: false }).limit(2000);
        if (error) throw error;
        res.json({ aliases: data || [] });
    } catch (err) {
        console.error('Alias list error:', err);
        res.status(500).json({ error: 'Failed to load mappings.' });
    }
});

/** PUT /api/admin/master/aliases/:id — record the customer's approval. */
router.put('/aliases/:id', async (req, res) => {
    try {
        if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid mapping id.' });
        const approved = req.body.approved === true;
        // Who at the customer approved it, in their words. An approval with no
        // name attached is not evidence of anything.
        const by = stripHtml(clean(req.body.approved_by));
        if (approved && !by) {
            return res.status(400).json({ error: 'Record who at the customer approved this mapping.' });
        }
        const { data, error } = await supabaseAdmin.from('company_item_aliases')
            .update({ approved, approved_at: approved ? new Date().toISOString() : null,
                      approved_by: approved ? by : null })
            .eq('id', req.params.id).select().single();
        if (error) throw error;

        await supabaseAdmin.from('audit_log').insert({
            admin_id: req.admin.id, action: approved ? 'item_alias_approved' : 'item_alias_unapproved',
            entity_type: 'company_item_aliases', entity_id: req.params.id,
            details: { approved_by: by || null }, ip_address: req.ip
        }).then(() => {}, () => {});

        res.json({ message: approved ? 'Approved — it now counts in cross-shop reporting.' : 'Approval removed.', alias: data });
    } catch (err) {
        console.error('Alias update error:', err);
        res.status(500).json({ error: 'Failed to update that mapping.' });
    }
});

/** DELETE /api/admin/master/aliases/:id */
router.delete('/aliases/:id', async (req, res) => {
    try {
        if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid mapping id.' });
        const { error } = await supabaseAdmin.from('company_item_aliases').delete().eq('id', req.params.id);
        if (error) throw error;
        await supabaseAdmin.from('audit_log').insert({
            admin_id: req.admin.id, action: 'item_alias_deleted', entity_type: 'company_item_aliases',
            entity_id: req.params.id, details: {}, ip_address: req.ip
        }).then(() => {}, () => {});
        res.json({ message: 'Mapping removed.' });
    } catch (err) {
        console.error('Alias delete error:', err);
        res.status(500).json({ error: 'Failed to remove that mapping.' });
    }
});

// ==================================================================
// MASTER-FIRST EDITING
//
// An item is created here, once, and pushed out. It is never typed into a
// company's catalogue from scratch — that is how the same part ends up with
// three spellings, two barcodes and a name nobody can group on.
// ==================================================================

/** POST /api/admin/master/items — add one part to the master table. */
router.post('/items', async (req, res) => {
    try {
        const sku = clean(req.body.sku);
        const name = stripHtml(clean(req.body.name));
        if (!sku) return res.status(400).json({ error: 'A part number is required.' });
        if (!name) return res.status(400).json({ error: 'An item name is required — a part with no name cannot be looked up or reported on.' });

        const key = skuKey(sku);
        const { data: clash } = await supabaseAdmin.from('item_library')
            .select('sku, name').eq('sku_key', key).maybeSingle();
        if (clash) {
            return res.status(409).json({
                error: `${sku} is already the same part as ${clash.sku} — ${clash.name}. Edit that one instead.`
            });
        }

        const barcode = clean(req.body.barcode) || null;
        if (barcode) {
            const { data: owner } = await supabaseAdmin.from('item_library')
                .select('sku, name').eq('barcode', barcode).maybeSingle();
            if (owner) {
                return res.status(409).json({
                    error: `Barcode ${barcode} is already on ${owner.sku} — ${owner.name}. One code cannot mean two parts.`
                });
            }
        }

        const { data, error } = await supabaseAdmin.from('item_library').insert({
            sku, sku_key: key, name,
            brand: clean(req.body.brand) || null,
            category: clean(req.body.category) || null,
            sub_category: clean(req.body.sub_category) || null,
            vendor_code: clean(req.body.vendor_code) || null,
            barcode, barcode_level: barcodeLevel(barcode),
            unit: clean(req.body.unit) || null,
            case_qty: numOrNull(req.body.case_qty),
            list_price: numOrNull(req.body.list_price),
            source: 'console',
            notes: stripHtml(clean(req.body.notes)) || null
        }).select().single();
        if (error) throw error;

        await supabaseAdmin.from('audit_log').insert({
            admin_id: req.admin.id, action: 'master_item_created', entity_type: 'item_library',
            entity_id: data.id, details: { sku, name }, ip_address: req.ip
        }).then(() => {}, () => {});

        res.status(201).json({ message: `${sku} added to the master table. Push it to customers when you are ready.`, item: data });
    } catch (err) {
        console.error('Master item create error:', err);
        res.status(500).json({ error: 'Failed to add that item.' });
    }
});

/** PUT /api/admin/master/items/:id — edit a master part. */
router.put('/items/:id', async (req, res) => {
    try {
        if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid item id.' });
        const { data: current } = await supabaseAdmin.from('item_library')
            .select('*').eq('id', req.params.id).maybeSingle();
        if (!current) return res.status(404).json({ error: 'That item is not in the master table.' });

        const patch = {};
        for (const f of ['name', 'brand', 'category', 'sub_category', 'vendor_code', 'unit', 'notes']) {
            if (req.body[f] !== undefined) patch[f] = stripHtml(clean(req.body[f])) || null;
        }
        for (const f of ['case_qty', 'list_price']) {
            if (req.body[f] !== undefined) patch[f] = numOrNull(req.body[f]);
        }
        if (req.body.is_active !== undefined) patch.is_active = req.body.is_active === true;

        if (req.body.barcode !== undefined) {
            const barcode = clean(req.body.barcode) || null;
            if (barcode) {
                const { data: owner } = await supabaseAdmin.from('item_library')
                    .select('id, sku, name').eq('barcode', barcode);
                const other = (owner || []).find(o => o.id !== current.id);
                if (other) {
                    return res.status(409).json({
                        error: `Barcode ${barcode} is already on ${other.sku} — ${other.name}. One code cannot mean two parts.`
                    });
                }
            }
            patch.barcode = barcode;
            patch.barcode_level = barcodeLevel(barcode);
        }
        if (patch.name === null) return res.status(400).json({ error: 'An item name is required.' });

        patch.updated_at = new Date().toISOString();
        const { data, error } = await supabaseAdmin.from('item_library')
            .update(patch).eq('id', req.params.id).select().single();
        if (error) throw error;

        await supabaseAdmin.from('audit_log').insert({
            admin_id: req.admin.id, action: 'master_item_updated', entity_type: 'item_library',
            entity_id: req.params.id,
            details: Object.fromEntries(Object.keys(patch).filter(k => k !== 'updated_at')
                .map(k => [k, { from: current[k] ?? null, to: patch[k] ?? null }])),
            ip_address: req.ip
        }).then(() => {}, () => {});

        res.json({ message: 'Saved.', item: data });
    } catch (err) {
        console.error('Master item update error:', err);
        res.status(500).json({ error: 'Failed to save that item.' });
    }
});

// ------------------------------------------------------------------
// Exclusions — the commercial rules that override the master default
// ------------------------------------------------------------------

/** GET /api/admin/master/exclusions */
router.get('/exclusions', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin.from('company_catalogue_exclusions')
            .select('id, company_id, brand, category, sku_key, reason, created_at')
            .order('created_at');
        if (error) throw error;
        const { data: companies } = await supabaseAdmin.from('companies').select('id, name');
        const nameOf = new Map((companies || []).map(c => [c.id, c.name]));
        res.json({ exclusions: (data || []).map(x => ({ ...x, company_name: nameOf.get(x.company_id) || 'Unknown' })) });
    } catch (err) {
        console.error('Exclusions list error:', err);
        res.status(500).json({ error: 'Failed to load exclusions.' });
    }
});

/** POST /api/admin/master/exclusions — "this customer does not get <brand>". */
router.post('/exclusions', async (req, res) => {
    try {
        const companyId = req.body.company_id;
        if (!isValidUUID(companyId)) return res.status(400).json({ error: 'A valid customer is required.' });

        const brand = clean(req.body.brand) || null;
        const category = clean(req.body.category) || null;
        const sku = clean(req.body.sku) || null;
        const dimensions = [brand, category, sku].filter(Boolean).length;
        if (dimensions !== 1) {
            return res.status(400).json({ error: 'Give exactly one of a brand, a category, or a part number.' });
        }
        // A reason is mandatory. An exclusion with no reason is indistinguishable
        // from a mistake six months later, and someone will remove it.
        const reason = stripHtml(clean(req.body.reason));
        if (!reason) {
            return res.status(400).json({ error: 'Say why this customer does not get it — the next person needs to know whether it still applies.' });
        }

        const { data, error } = await supabaseAdmin.from('company_catalogue_exclusions')
            .insert({ company_id: companyId, brand, category,
                      sku_key: sku ? skuKey(sku) : null, reason, created_by: req.admin.id })
            .select().single();
        if (error) {
            if (error.code === '23505') return res.status(409).json({ error: 'That rule already exists for this customer.' });
            throw error;
        }

        await supabaseAdmin.from('audit_log').insert({
            admin_id: req.admin.id, action: 'catalogue_exclusion_created',
            entity_type: 'company_catalogue_exclusions', entity_id: data.id,
            details: { company_id: companyId, brand, category, sku, reason }, ip_address: req.ip
        }).then(() => {}, () => {});

        res.status(201).json({ message: 'Rule added. Pushes to this customer will skip it from now on.', exclusion: data });
    } catch (err) {
        console.error('Exclusion create error:', err);
        res.status(500).json({ error: 'Failed to add that rule.' });
    }
});

/** DELETE /api/admin/master/exclusions/:id */
router.delete('/exclusions/:id', async (req, res) => {
    try {
        if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid rule id.' });
        const { error } = await supabaseAdmin.from('company_catalogue_exclusions').delete().eq('id', req.params.id);
        if (error) throw error;
        await supabaseAdmin.from('audit_log').insert({
            admin_id: req.admin.id, action: 'catalogue_exclusion_deleted',
            entity_type: 'company_catalogue_exclusions', entity_id: req.params.id,
            details: {}, ip_address: req.ip
        }).then(() => {}, () => {});
        res.json({ message: 'Rule removed. This customer can now receive those items.' });
    } catch (err) {
        console.error('Exclusion delete error:', err);
        res.status(500).json({ error: 'Failed to remove that rule.' });
    }
});

// ------------------------------------------------------------------
// Push from master to customer catalogues
// ------------------------------------------------------------------

/**
 * POST /api/admin/master/push
 *   { item_ids: [...] | sku_keys: [...] | brand: 'PPG' | all: true,
 *     company_ids: [...] | all_companies: true,
 *     apply: false }
 *
 * Copies master items into customer catalogues, at the master's list price
 * unless the customer already prices that part.
 *
 * THE THREE THINGS IT REFUSES TO DO
 *   - Push an item a commercial rule says that customer must not receive.
 *     PPG to Assured is the case this exists for.
 *   - Change a price the customer already has. A push adds parts; it is not
 *     a repricing tool, and silently moving prices would be the worst
 *     possible side effect of a button labelled "add items".
 *   - Run without being previewed first, unless apply is explicitly true.
 */
router.post('/push', async (req, res) => {
    try {
        const apply = req.body.apply === true;

        // ---- which items ----
        let items;
        if (Array.isArray(req.body.item_ids) && req.body.item_ids.length) {
            const ids = req.body.item_ids.filter(isValidUUID);
            if (!ids.length) return res.status(400).json({ error: 'No valid item ids were given.' });
            items = await readAll(() => supabaseAdmin.from('item_library')
                .select('id, sku, sku_key, name, brand, category, barcode, barcode_level, unit, case_qty, list_price, is_active')
                .in('id', ids));
        } else if (clean(req.body.brand)) {
            items = await readAll(() => supabaseAdmin.from('item_library')
                .select('id, sku, sku_key, name, brand, category, barcode, barcode_level, unit, case_qty, list_price, is_active')
                .eq('brand', clean(req.body.brand)));
        } else if (req.body.all === true) {
            items = await readAll(() => supabaseAdmin.from('item_library')
                .select('id, sku, sku_key, name, brand, category, barcode, barcode_level, unit, case_qty, list_price, is_active'));
        } else {
            return res.status(400).json({ error: 'Choose which items to push: some ids, a brand, or all of them.' });
        }
        items = items.filter(i => i.is_active !== false);
        if (!items.length) return res.status(400).json({ error: 'That selection matched no active master items.' });

        // ---- which customers ----
        const allCompanies = await readAll(() => supabaseAdmin.from('companies')
            .select('id, name, is_active').eq('is_active', true));
        let companies = allCompanies;
        if (Array.isArray(req.body.company_ids) && req.body.company_ids.length) {
            const wanted = new Set(req.body.company_ids.filter(isValidUUID));
            companies = allCompanies.filter(c => wanted.has(c.id));
        } else if (req.body.all_companies !== true) {
            return res.status(400).json({ error: 'Choose which customers to push to, or say all of them.' });
        }
        if (!companies.length) return res.status(400).json({ error: 'No active customers matched.' });

        // ---- the commercial rules ----
        const exclusions = await readAll(() => supabaseAdmin.from('company_catalogue_exclusions')
            .select('company_id, brand, category, sku_key, reason'));
        const rulesFor = new Map();
        for (const x of exclusions) {
            if (!rulesFor.has(x.company_id)) rulesFor.set(x.company_id, []);
            rulesFor.get(x.company_id).push(x);
        }
        const blockedBy = (companyId, item) => {
            for (const r of rulesFor.get(companyId) || []) {
                if (r.brand && String(r.brand).toLowerCase() === String(item.brand || '').toLowerCase()) return r;
                if (r.category && String(r.category).toLowerCase() === String(item.category || '').toLowerCase()) return r;
                if (r.sku_key && r.sku_key === item.sku_key) return r;
            }
            return null;
        };

        // ---- plan, per customer ----
        const perCompany = [];
        const toInsert = [];
        for (const co of companies) {
            const existing = await readAll(() => supabaseAdmin.from('products')
                .select('id, sku').eq('company_id', co.id));
            const have = new Set(existing.map(p => skuKey(p.sku)));

            let added = 0, already = 0;
            const excluded = [];
            for (const item of items) {
                const rule = blockedBy(co.id, item);
                if (rule) { excluded.push({ sku: item.sku, brand: item.brand, reason: rule.reason }); continue; }
                if (have.has(item.sku_key)) { already += 1; continue; }
                added += 1;
                if (apply) {
                    toInsert.push({
                        company_id: co.id, sku: item.sku, name: item.name,
                        brand: item.brand, category: item.category,
                        // The master's list price is a starting point. A part
                        // with no price arrives as price-on-request rather than
                        // as free, which is the only honest default.
                        price: item.list_price === null || item.list_price === undefined ? 0 : item.list_price,
                        price_on_request: !(Number(item.list_price) > 0),
                        case_qty: item.case_qty || 1,
                        unit: item.unit || 'each',
                        is_active: true,
                        __barcode: item.barcode || null
                    });
                }
            }
            perCompany.push({
                company_id: co.id, company_name: co.name,
                would_add: added, already_had: already,
                excluded_count: excluded.length,
                excluded_examples: excluded.slice(0, 5),
                excluded_reason: excluded.length ? excluded[0].reason : null
            });
        }

        const summary = {
            items_selected: items.length,
            customers: companies.length,
            to_add: perCompany.reduce((s, c) => s + c.would_add, 0),
            already_present: perCompany.reduce((s, c) => s + c.already_had, 0),
            blocked_by_rules: perCompany.reduce((s, c) => s + c.excluded_count, 0)
        };

        if (!apply) return res.json({ applied: false, summary, by_company: perCompany });

        // ---- write ----
        let created = 0, barcodesSet = 0;
        for (let i = 0; i < toInsert.length; i += 200) {
            const slice = toInsert.slice(i, i + 200);
            const payload = slice.map(({ __barcode, ...row }) => row);
            const { data: inserted, error } = await supabaseAdmin.from('products').insert(payload).select('id, sku, company_id');
            if (error) throw error;
            created += payload.length;

            // Carry the master barcode across, but never onto a code that is
            // already in use inside that customer's catalogue.
            const rows = Array.isArray(inserted) ? inserted : [inserted];
            for (let j = 0; j < rows.length; j++) {
                const code = slice[j] && slice[j].__barcode;
                if (!code || !rows[j]) continue;
                const { data: holders } = await supabaseAdmin.from('product_barcodes')
                    .select('product_id').eq('barcode', code);
                const ids = (holders || []).map(h => h.product_id).filter(Boolean);
                let clash = false;
                if (ids.length) {
                    const { data: owners } = await supabaseAdmin.from('products')
                        .select('id, company_id').in('id', ids);
                    clash = (owners || []).some(o => o.company_id === rows[j].company_id);
                }
                if (clash) continue;
                const { error: bErr } = await supabaseAdmin.from('product_barcodes').insert({
                    product_id: rows[j].id, barcode: code,
                    symbology: code.length === 13 ? 'EAN_13' : code.length === 12 ? 'UPC_A' : 'OTHER',
                    is_primary: true, source: 'master', is_internal: false
                });
                if (!bErr) barcodesSet += 1;
            }
        }

        await supabaseAdmin.from('audit_log').insert({
            admin_id: req.admin.id, action: 'master_items_pushed', entity_type: 'item_library',
            entity_id: null, details: { ...summary, created, barcodes_set: barcodesSet },
            ip_address: req.ip
        }).then(() => {}, () => {});

        res.json({ applied: true, summary: { ...summary, created, barcodes_set: barcodesSet }, by_company: perCompany });

    } catch (err) {
        console.error('Master push error:', err);
        res.status(500).json({ error: 'The push failed.' });
    }
});

module.exports = router;
module.exports._internals = { skuKey, barcodeLevel, mapHeaders, parseWorkbook, planImport, clean };
