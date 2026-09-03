/**
 * routes/crossover-reference-admin.js
 *
 * refinishAI Inventory — the brand-crossover reference sheet, mounted from
 * server.js at /api/admin/crossover
 *
 * This is CHC's own reference for "if a shop wants this in Norton/3M/SEM/
 * Kent/Wurth instead of Fusor, here's the part" -- searchable so curating a
 * kit line's alternatives (routes/inventory-kits-master.js) means picking
 * from a real list, and re-importable so the next crossover sheet CHC gets
 * (a new brand, an updated price list) loads without a code change.
 *
 * Super-admin only, enforced here rather than by hiding a nav tab.
 */

const express = require('express');
const XLSX = require('xlsx');
const { supabaseAdmin } = require('../utils/supabase');
const { requireSuperAdmin } = require('../middleware/auth');
const { catalogUpload } = require('../middleware/upload');
const { stripHtml } = require('../utils/sanitize');
const { parseCrossoverWorkbook } = require('../utils/crossover-import');

const router = express.Router();

router.use(requireSuperAdmin);

function text(v, max = 200) {
    return stripHtml(String(v === undefined || v === null ? '' : v)).trim().slice(0, max);
}

/**
 * GET /crossover/search?q=&brand=&limit=
 * Free-text search across both sides of the sheet -- typing a Fusor part, a
 * competitor part, or a product name all work, because whoever is curating
 * a kit line may know the part by any of them.
 */
router.get('/search', async (req, res) => {
    try {
        const q = text(req.query.q, 100);
        const brand = text(req.query.brand, 60);
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));

        let query = supabaseAdmin
            .from('product_crossover_reference')
            .select('id, base_brand, base_category, base_name, base_part_number, base_speed, base_size, alt_brand, alt_product_line, alt_name, alt_part_number, alt_speed, alt_size')
            .order('base_part_number', { ascending: true })
            .limit(limit);

        if (brand) query = query.eq('alt_brand', brand);
        if (q) {
            const like = `%${q.replace(/[%_]/g, '')}%`;
            query = query.or(`base_part_number.ilike.${like},base_name.ilike.${like},alt_part_number.ilike.${like},alt_name.ilike.${like}`);
        }

        const { data, error } = await query;
        if (error) throw error;

        res.json({ results: data || [] });
    } catch (err) {
        console.error('Crossover search error:', err);
        res.status(500).json({ error: 'Search failed.' });
    }
});

/** GET /crossover/brands — for a filter dropdown. */
router.get('/brands', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin.from('product_crossover_reference').select('alt_brand');
        if (error) throw error;
        const counts = new Map();
        for (const r of data || []) counts.set(r.alt_brand, (counts.get(r.alt_brand) || 0) + 1);
        res.json({ brands: [...counts.entries()].map(([brand, count]) => ({ brand, count })).sort((a, b) => a.brand.localeCompare(b.brand)) });
    } catch (err) {
        console.error('Crossover brands error:', err);
        res.status(500).json({ error: 'Failed to load brands.' });
    }
});

/**
 * POST /crossover/import
 * multipart/form-data, field "file": an .xlsx crossover sheet shaped like
 * the ones this table already holds (base brand on the left, one
 * competitor's columns on the right, one sheet per brand -- see
 * utils/crossover-import.js for the exact layouts recognised). Additive:
 * re-importing does not remove or de-duplicate anything already here, so a
 * corrected sheet is reviewed the same way any other addition would be.
 */
router.post('/import', catalogUpload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

        let workbook;
        try {
            workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
        } catch (e) {
            return res.status(400).json({ error: 'That file could not be read as a spreadsheet.' });
        }

        const rows = parseCrossoverWorkbook(XLSX, workbook, text(req.file.originalname, 200));
        if (rows.length === 0) {
            return res.status(400).json({ error: 'No recognisable crossover sheets found in that file (expected sheet names like "Norton Speed Grip", "3M Duramix", "SEM", "Kent", "Wurth").' });
        }
        if (rows.length > 5000) return res.status(400).json({ error: 'That file has more rows than one import can take at once.' });

        const { error } = await supabaseAdmin
            .from('product_crossover_reference')
            .insert(rows.map(r => ({ ...r, imported_by: req.admin.id })));
        if (error) throw error;

        await supabaseAdmin.from('audit_log').insert({
            admin_id: req.admin.id, action: 'crossover_reference_imported', entity_type: 'crossover_reference', entity_id: null,
            details: { filename: req.file.originalname, rows: rows.length }, ip_address: req.ip
        });

        const byBrand = {};
        for (const r of rows) byBrand[r.alt_brand] = (byBrand[r.alt_brand] || 0) + 1;

        res.status(201).json({ message: `${rows.length} crossover row(s) imported.`, imported: rows.length, by_brand: byBrand });
    } catch (err) {
        console.error('Crossover import error:', err);
        res.status(500).json({ error: 'Import failed.' });
    }
});

/** DELETE /crossover/:id — remove one bad reference row. */
router.delete('/:id', async (req, res) => {
    try {
        const { error, count } = await supabaseAdmin
            .from('product_crossover_reference').delete({ count: 'exact' }).eq('id', req.params.id);
        if (error) throw error;
        if (!count) return res.status(404).json({ error: 'Reference row not found.' });
        res.json({ message: 'Removed.' });
    } catch (err) {
        console.error('Crossover delete error:', err);
        res.status(500).json({ error: 'Failed to remove that row.' });
    }
});

module.exports = router;
