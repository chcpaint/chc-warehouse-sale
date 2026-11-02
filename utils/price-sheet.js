/**
 * utils/price-sheet.js
 *
 * Reading a vendor's price sheet the way people actually send them.
 *
 * Real sheets are not tidy tables. They come out of accounting systems with the
 * company's name and address across the top, a report title, a blank line, and
 * only then the column headings; prices are typed as text ("$3.69"); and the
 * tab is called "Sheet1". The importer used to assume row 1 was the header and
 * every price was a bare number, so a perfectly complete sheet failed with
 * nothing but "invalid price" on every line.
 *
 * Pure functions, no I/O, so each rule can be tested on its own.
 */

// Header spellings the importer understands, after lower-casing and turning
// whitespace into underscores. Kept here so the header finder and the row
// normaliser agree about what a "SKU column" is.
const XLSX = require('xlsx');
const detect = require('./sheet-detect');

const HEADER_ALIASES = {
    sku:   ['sku', 'item_#', 'item_number', 'itemnumber', 'item_no', 'item_no.', 'part_number', 'partnumber', 'part_no', 'part_#', 'part', 'upc'],
    name:  ['item_name', 'name', 'product', 'product_name', 'productname', 'description', 'item'],
    price: ['warehouse_sale_price', 'price', 'sale_price', 'saleprice', 'unit_price', 'selling_price', 'ae_selling_price', 'current_price',
            'regular_price', 'list_price', 'listprice', 'msrp', 'cost', 'new_price']
};

const headerKey = v => String(v == null ? '' : v).toLowerCase().trim().replace(/\s+/g, '_');

/**
 * Which row of a sheet (as an array of arrays) holds the column headings?
 * The first one that names at least two of: part number, product name, price.
 * Searches the first 60 rows. Falls back to row 0 so a plain table behaves
 * exactly as it always did.
 */
function findHeaderRow(matrix, limit = 60) {
    const top = Math.min(matrix.length, limit);
    for (let i = 0; i < top; i++) {
        const keys = (matrix[i] || []).map(headerKey).filter(Boolean);
        if (!keys.length) continue;
        let kinds = 0;
        for (const kind of Object.keys(HEADER_ALIASES)) {
            if (keys.some(k => HEADER_ALIASES[kind].includes(k))) kinds++;
        }
        if (kinds >= 2) return i;
    }
    return 0;
}

/**
 * Turn a sheet matrix into row objects keyed by the header names, remembering
 * which spreadsheet line each came from (so an error can say "row 57" and mean
 * the number the person sees in Excel).
 */
function matrixToRows(matrix) {
    if (!matrix || !matrix.length) return { rows: [], headerRow: 0 };
    const h = findHeaderRow(matrix);
    const headers = (matrix[h] || []).map(c => String(c == null ? '' : c).trim());
    const rows = [];
    for (let i = h + 1; i < matrix.length; i++) {
        const cells = matrix[i] || [];
        if (!cells.some(c => String(c == null ? '' : c).trim() !== '')) continue;   // blank line
        const obj = {};
        headers.forEach((name, c) => {
            if (!name) return;
            const v = cells[c];
            if (v !== undefined && v !== null && String(v).trim() !== '') obj[name] = v;
        });
        Object.defineProperty(obj, '__row', { value: i + 1, enumerable: false });
        rows.push(obj);
    }
    return { rows, headerRow: h + 1 };
}

/**
 * "$1,234.50", " 3.69 ", "CAD 12", 12.5  ->  number. Anything else -> NaN.
 * Never guesses: "N/A" or "call" is NaN, not 0.
 */
function parsePrice(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    if (v === undefined || v === null) return NaN;
    let s = String(v).trim();
    if (!s) return NaN;
    const negative = /^\(.*\)$/.test(s);                 // accounting style (12.50)
    s = s.replace(/[()$,\s]/g, '').replace(/^(CAD|USD|CA|US)/i, '');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
    const n = parseFloat(s);
    return negative ? -n : n;
}

// A tab called "Sheet1" says nothing about the vendor; using it as the brand
// would file every part under "Sheet1".
const isGenericSheetName = name => /^(sheet|page|tab|worksheet|export|report)[\s_-]*\d*$/i.test(String(name || '').trim());



/**
 * Wrap rows with how the file was read. Kept as a hidden property so callers
 * that only want the rows (and the older tests) still get a plain array.
 */
function withMeta(rows, meta) {
    Object.defineProperty(rows, 'meta', { value: meta, enumerable: false });
    return rows;
}

const metaOf = (r, extra = {}) => ({
    ok: r.ok, header_row: r.headerRow, mapping: r.mapping, sources: r.sources, columns: r.columns,
    no_price: !!r.noPrice, preview: r.preview, repaired: r.repaired, warnings: r.warnings, missing: r.missing,
    skipped_no_name: r.skippedNoName, ...extra
});

/**
 * opts.columnMap  { role: columnIndex|null }  a person's override of the detected columns
 * opts.headerRow  1-based line holding the headings, 0 for none
 */
async function parseCSV(buffer, opts = {}) {
    // Any delimiter, any common encoding, title block or none: see utils/sheet-detect.js
    const { grid, delimiter } = detect.csvToMatrix(detect.decodeText(buffer));
    const r = detect.readSheet(grid, opts);
    return withMeta(r.rows, metaOf(r, { delimiter, sheet: null }));
}

function parseExcel(buffer, opts = {}) {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const allRows = [];
    const sheets = [];

    // Sheets to skip (internal/reference data, not product catalogs)
    const skipSheets = ['itemswb11926', 'lastcost'];

    for (const sheetName of workbook.SheetNames) {
        if (skipSheets.includes(sheetName.trim().toLowerCase())) continue;

        const sheet = workbook.Sheets[sheetName];
        // A grid, not sheet_to_json's "first row is the header": vendor sheets
        // usually carry a title block above the real column headings. The same
        // grid as displayed text is read alongside so part numbers keep the
        // leading zeros Excel shows.
        const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
        if (!matrix.length) continue;
        const fmtMatrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
        const r = detect.readSheet(matrix, { ...opts, fmtMatrix });
        sheets.push({ name: sheetName.trim(), r });

        // Use the tab name as the brand if there is no brand column -- unless the
        // tab is just called "Sheet1", which says nothing about the vendor.
        const brandFromSheet = isGenericSheetName(sheetName) ? '' : sheetName.trim();
        for (const row of r.rows) {
            if (brandFromSheet && row.__v.brand === undefined) row['_sheet_brand'] = brandFromSheet;
            allRows.push(row);
        }
    }
    // Describe the sheet that produced the most rows; if none produced any, the
    // first that had content, so the person can see why and fix the columns.
    const usable = sheets.filter(x => x.r.ok).sort((a, b) => b.r.rows.length - a.r.rows.length);
    const shown = usable[0] || sheets[0];
    const meta = shown ? metaOf(shown.r, { sheet: shown.name, sheet_count: sheets.length, ok: usable.length > 0 })
        : { ok: false, columns: [], preview: [], mapping: {}, sources: {}, warnings: [], missing: ['name', 'price'], repaired: 0, skipped_no_name: 0 };
    return withMeta(allRows, meta);
}

function normalizeProductRow(row, opts = {}) {
    // Flexible column name mapping
    const mappings = {
        brand: ['brand', 'manufacturer', 'mfg', 'make'],
        name: ['item_name', 'name', 'product', 'product_name', 'productname', 'description', 'item'],
        sku: ['sku', 'item_#', 'item_number', 'itemnumber', 'item_no', 'item_no.', 'part_number', 'partnumber', 'part_no', 'part_#', 'part', 'upc'],
        description: ['description', 'item_description', 'desc', 'details', 'product_description'],
        category: ['category', 'cat', 'type', 'product_type', 'group', 'custom_list_#1'],
        price: ['warehouse_sale_price', 'price', 'sale_price', 'saleprice', 'unit_price', 'selling_price', 'ae_selling_price', 'current_price', 'new_price'],
        previous_price: ['previous_price', 'previousprice', 'regular_price', 'regularprice', 'msrp', 'list_price', 'listprice', 'was_price'],
        case_qty: ['case_quantity', 'case_qty', 'caseqty', 'casequantity', 'qty_per_case', 'pack_size', 'packsize'],
        unit: ['unit', 'uom', 'unit_of_measure'],
        image_url: ['image_url', 'imageurl', 'image', 'photo', 'picture']
    };

    const normalized = {};
    const lowerRow = {};
    for (const [key, val] of Object.entries(row)) {
        lowerRow[key.toLowerCase().trim().replace(/\s+/g, '_')] = val;
    }

    if (row.__v) {
        // The sheet reader already decided which column is which (by heading and
        // by content, or by a person's choice): use exactly that, never a guess
        // from heading spelling.
        for (const [field, val] of Object.entries(row.__v)) {
            if (val !== undefined && val !== null && String(val).trim() !== '') normalized[field] = val;
        }
    } else {
        for (const [field, aliases] of Object.entries(mappings)) {
            for (const alias of aliases) {
                const val = lowerRow[alias];
                if (val !== undefined && val !== null && String(val).trim() !== '') {
                    normalized[field] = val;
                    break;
                }
            }
        }
    }

    // Validate required fields
    if (!normalized.name) throw new Error('Missing product name');
    normalized.name = String(normalized.name).trim();
    if (normalized.sku !== undefined) normalized.sku = String(normalized.sku).trim();
    // Brand: the sheet's own Brand column wins; then the vendor the person typed
    // into the upload; then the tab name (never a generic "Sheet1").
    if (!normalized.brand) normalized.brand = opts.vendor || lowerRow._sheet_brand || 'Uncategorized';
    // A description that only repeats the name adds nothing.
    if (normalized.description && String(normalized.description).trim() === normalized.name) delete normalized.description;

    // Price required; allow 0 through (the import step skips non-positive prices).
    // Accepts "$3.69", "1,234.50" and plain numbers.
    let price = parsePrice(normalized.price);
    if (!Number.isFinite(price)) {
        const prev = parsePrice(normalized.previous_price);
        if (Number.isFinite(prev)) price = prev;
        else if (opts.allowNoPrice && normalized.price === undefined) price = 0;   // priced later from the master list
        else throw new Error(normalized.price === undefined ? 'No price on this line' : `Price "${String(normalized.price).slice(0, 20)}" is not a number`);
    }

    // Type conversions
    normalized.price = price;
    if (normalized.previous_price !== undefined) {
        const pp = parsePrice(normalized.previous_price);
        if (Number.isFinite(pp)) normalized.previous_price = pp; else delete normalized.previous_price;
    }
    if (normalized.case_qty) normalized.case_qty = parseInt(normalized.case_qty) || 1;
    normalized.is_active = true;

    return normalized;
}

module.exports = { HEADER_ALIASES, headerKey, findHeaderRow, matrixToRows, parsePrice, isGenericSheetName, parseCSV, parseExcel, normalizeProductRow };
