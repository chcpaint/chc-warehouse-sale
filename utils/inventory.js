/**
 * utils/inventory.js
 *
 * Pure, dependency-free logic for refinishAI Inventory: barcode normalisation,
 * master-file row parsing, movement arithmetic and replenishment maths.
 *
 * Everything here is a pure function so it can be unit tested without a
 * database. The route files hold the I/O; this file holds the rules.
 */

// ============================================================
// MOVEMENT TYPES
// ============================================================

/**
 * The ledger vocabulary. `sign` is the direction a positive user-entered
 * quantity moves stock: consuming 3 units writes qty_change = -3.
 * `absolute` types set on-hand to a value rather than adjusting by one.
 */
const MOVEMENT_TYPES = {
    receive:      { sign: +1, absolute: false, label: 'Received' },
    consume:      { sign: -1, absolute: false, label: 'Used on a job' },
    adjust:       { sign: +1, absolute: false, label: 'Adjustment' },      // caller supplies a signed qty
    count:        { sign: +1, absolute: true,  label: 'Cycle count' },     // qty is the counted on-hand
    transfer_in:  { sign: +1, absolute: false, label: 'Transferred in' },
    transfer_out: { sign: -1, absolute: false, label: 'Transferred out' },
    seed:         { sign: +1, absolute: false, label: 'Opening balance' }
};

const MOVEMENT_TYPE_NAMES = Object.keys(MOVEMENT_TYPES);

/** Movement types a storefront (shop-floor) user is allowed to post. */
const STORE_MOVEMENT_TYPES = ['consume', 'receive', 'count', 'adjust'];

// ============================================================
// BARCODES
// ============================================================

/**
 * Strip the noise a scanner or a spreadsheet adds around a barcode: wedge
 * scanners can emit stray whitespace, Excel loves to append `.0` to a numeric
 * UPC column, and copy-paste brings non-breaking spaces.
 * @param {*} raw
 * @returns {string}
 */
function cleanBarcode(raw) {
    let s = String(raw === undefined || raw === null ? '' : raw)
        .replace(/[\u00a0\u2007\u202f\u200b\ufeff]/g, ' ')   // nbsp, thin/zero-width spaces, BOM
        .trim();
    if (/^\d+\.0+$/.test(s)) s = s.split('.')[0];              // Excel numeric coercion
    if (/^\d+(\.\d+)?e\+?\d+$/i.test(s)) {                     // Excel scientific notation
        const n = Number(s);
        if (Number.isFinite(n) && Number.isSafeInteger(n)) s = String(n);
    }
    s = s.replace(/\s+/g, '');
    // A hyphen inside an all-numeric code is a human separator ("051-131-020474")
    // and is dropped. A hyphen inside an alphanumeric code is a real Code-39
    // character ("CHC-PAINT-001") and is kept.
    if (/^[\d-]+$/.test(s)) s = s.replace(/-/g, '');
    return s;
}

/** GS1 mod-10 check digit for a UPC/EAN body (all digits except the last). */
function gs1CheckDigit(body) {
    const digits = String(body).split('').map(Number);
    let sum = 0;
    // Weight 3 applies to the digit immediately left of the check digit and
    // alternates outward, so weighting is anchored to the right-hand end.
    for (let i = digits.length - 1, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) {
        sum += digits[i] * weight;
    }
    return (10 - (sum % 10)) % 10;
}

/**
 * Is this a structurally valid UPC-A / EAN-13 / EAN-8 / ITF-14 code?
 * Used to decide whether a spreadsheet's "UPC" cell is a real barcode or junk.
 */
function isValidGs1(code) {
    const s = cleanBarcode(code);
    if (!/^\d+$/.test(s)) return false;
    if (![8, 12, 13, 14].includes(s.length)) return false;
    return gs1CheckDigit(s.slice(0, -1)) === Number(s.slice(-1));
}

/**
 * Recover a GTIN whose leading zero a spreadsheet ate.
 *
 * Excel stores a UPC column as a number, so "051131020474" comes back as
 * 51131020474 — eleven digits with a check digit that no longer validates. In
 * the CHC master file this affects roughly 25 of 565 coded rows. Zero-padding
 * back out to a standard length and re-testing the check digit recovers the
 * real code without guessing.
 *
 * @param {*} raw
 * @returns {{code: string, recovered: boolean, valid: boolean}}
 */
function recoverGs1(raw) {
    const s = cleanBarcode(raw);
    if (!/^\d+$/.test(s)) return { code: s, recovered: false, valid: false };
    if (isValidGs1(s)) return { code: s, recovered: false, valid: true };

    for (const len of [8, 12, 13, 14]) {
        if (s.length >= len) continue;
        const padded = s.padStart(len, '0');
        if (isValidGs1(padded)) return { code: padded, recovered: true, valid: true };
    }
    return { code: s, recovered: false, valid: false };
}

/** Best guess at the symbology of a scanned or imported code. */
function detectSymbology(code) {
    const s = cleanBarcode(code);
    if (/^\d{12}$/.test(s)) return 'upc_a';
    if (/^\d{13}$/.test(s)) return 'ean_13';
    if (/^\d{8}$/.test(s))  return 'ean_8';
    if (/^\d{14}$/.test(s)) return 'itf';
    if (/^[0-9A-Z\-. $/+%]+$/.test(s)) return 'code_39';
    if (/^[\x20-\x7e]+$/.test(s)) return 'code_128';
    return 'other';
}

/**
 * Every form a single physical barcode might be stored as, so a scan matches
 * regardless of how the catalogue recorded it.
 *
 * The cases that matter in practice:
 *  - a UPC-A printed on the box is the same GTIN as the EAN-13 with a leading 0
 *  - some scanners transmit UPC-A as 13 digits and some as 12
 *  - suppliers pad codes to 14-digit GTIN in their price files
 *
 * @param {*} raw
 * @returns {string[]} unique candidates, most specific first
 */
function barcodeVariants(raw) {
    const s = cleanBarcode(raw);
    if (!s) return [];
    const out = [s];

    if (/^\d+$/.test(s)) {
        const trimmed = s.replace(/^0+/, '') || '0';
        for (const len of [8, 12, 13, 14]) {
            if (trimmed.length <= len) out.push(trimmed.padStart(len, '0'));
        }
        out.push(trimmed);
    } else {
        out.push(s.toUpperCase());
    }

    return [...new Set(out.filter(Boolean))];
}

/**
 * Canonical storage form. Numeric GTINs are stored as 13-digit EAN so a UPC-A
 * and its EAN-13 equivalent never occupy two rows; everything else is stored
 * uppercased and trimmed.
 */
function canonicalBarcode(raw) {
    const s = cleanBarcode(raw);
    if (!s) return '';
    if (/^\d+$/.test(s) && s.length <= 13) {
        return (s.replace(/^0+/, '') || '0').padStart(13, '0');
    }
    return /^\d+$/.test(s) ? s : s.toUpperCase();
}

// ============================================================
// MASTER FILE PARSING
// ============================================================

/**
 * Parse a currency-ish cell: "$84.48", "1,234.50", "84.48 CAD", 84.48.
 * @returns {number|null} null when the cell holds no usable number
 */
function parseMoney(v) {
    if (v === undefined || v === null) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = String(v).replace(/[^0-9.\-]/g, '');
    if (!s || s === '-' || s === '.') return null;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
}

/** Parse a quantity cell to a finite number, or null. */
function parseQty(v) {
    if (v === undefined || v === null || String(v).trim() === '') return null;
    const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
}

/** Normalise a header cell to a lookup key: "MSRP (Selling Price)" -> "msrp_selling_price". */
function headerKey(h) {
    return String(h || '')
        .replace(/﻿/g, '')          // BOM from Excel-exported CSV
        .toLowerCase()
        .trim()
        .replace(/[()#]/g, ' ')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

/**
 * Column aliases for the inventory master file. Deliberately wider than the
 * catalogue importer's map in routes/admin.js, because the CHC master file uses
 * headers that map does not recognise — "Item Number (Part #)",
 * "MSRP (Selling Price)" and "Product Category" all fall through it, which
 * would import the file with no SKU, no price and no category.
 */
const MASTER_FIELD_ALIASES = {
    sku:                 ['item_number_part', 'item_number', 'item_no', 'item', 'part_number', 'part_no', 'partnumber', 'sku', 'stock_code', 'product_code', 'code'],
    name:                ['item_name', 'name', 'product_name', 'product', 'description_1', 'item_description'],
    category:            ['product_category', 'category', 'cat', 'product_type', 'group'],
    sub_category:        ['sub_category', 'subcategory', 'sub_cat', 'line', 'product_line'],
    brand:               ['brand', 'manufacturer', 'mfg', 'make', 'vendor', 'supplier', '_sheet_brand'],
    vendor_item_number:  ['vendor_item_number', 'vendor_item', 'vendor_part', 'supplier_item_number', 'supplier_code'],
    price:               ['msrp_selling_price', 'selling_price', 'msrp', 'price', 'sale_price', 'unit_price', 'list_price', 'warehouse_sale_price'],
    barcode:             ['upc', 'ean', 'gtin', 'barcode', 'bar_code', 'upc_code', 'upc_a'],
    case_qty:            ['case_qty', 'case_quantity', 'qty_per_case', 'pack_size', 'pack_qty', 'units_per_case'],
    unit:                ['unit', 'uom', 'unit_of_measure'],
    notes:               ['notes', 'note', 'comment', 'comments', 'remarks'],
    // Optional per-location seeding columns
    on_hand:             ['on_hand', 'onhand', 'qty_on_hand', 'quantity', 'qty', 'current_stock', 'stock', 'count'],
    min_point:           ['min', 'min_point', 'minimum', 'min_qty', 'reorder_point', 'shelf_min'],
    max_point:           ['max', 'max_point', 'maximum', 'max_qty', 'shelf_max', 'order_up_to'],
    reorder_qty:         ['reorder_qty', 'reorder_quantity', 'order_qty', 'default_order_qty'],
    bin_location:        ['bin', 'bin_location', 'shelf', 'location_bin', 'aisle', 'slot']
};

/**
 * Turn one raw spreadsheet row into a normalised master-file record.
 *
 * Returns `{ ok: false, error }` rather than throwing so a single bad row can
 * be reported back to the uploader without aborting an 883-row import.
 *
 * @param {Object} row raw row keyed by original header text
 * @returns {{ok: true, value: Object} | {ok: false, error: string}}
 */
function normalizeMasterRow(row) {
    const lower = {};
    for (const [k, v] of Object.entries(row || {})) {
        const key = headerKey(k);
        if (key && (lower[key] === undefined || String(lower[key]).trim() === '')) lower[key] = v;
    }

    const pick = (field) => {
        for (const alias of MASTER_FIELD_ALIASES[field] || []) {
            const v = lower[alias];
            if (v !== undefined && v !== null && String(v).trim() !== '') return v;
        }
        return undefined;
    };

    const value = {};
    const str = (v) => String(v).trim();

    const name = pick('name');
    if (!name || !str(name)) return { ok: false, error: 'Missing item name' };
    value.name = str(name);

    const sku = pick('sku');
    if (!sku || !str(sku)) return { ok: false, error: `Missing item number for "${value.name}"` };
    value.sku = str(sku);

    value.brand = pick('brand') ? str(pick('brand')) : 'Uncategorized';
    value.category = pick('category') ? str(pick('category')) : null;
    value.sub_category = pick('sub_category') ? str(pick('sub_category')) : null;
    value.vendor_item_number = pick('vendor_item_number') ? str(pick('vendor_item_number')) : null;
    value.notes = pick('notes') ? str(pick('notes')) : null;
    value.unit = pick('unit') ? str(pick('unit')) : null;

    value.price = parseMoney(pick('price'));
    const caseQty = parseQty(pick('case_qty'));
    value.case_qty = caseQty && caseQty > 0 ? Math.round(caseQty) : null;

    const rawBarcode = pick('barcode');
    if (rawBarcode !== undefined) {
        const cleaned = cleanBarcode(rawBarcode);
        if (cleaned) {
            const recovered = recoverGs1(cleaned);
            value.barcode = canonicalBarcode(recovered.code);
            value.barcode_raw = cleaned;
            // Detect from the value that is actually stored, not the raw cell:
            // an 11-digit spreadsheet code is stored as a 13-digit EAN, and
            // labelling it Code 39 because it was short would be wrong.
            value.barcode_symbology = detectSymbology(value.barcode);
            // Flagged, not rejected: a code that still fails its check digit
            // after zero-padding is usually a typo or a private supplier code,
            // and the buyer still wants the row imported.
            value.barcode_checksum_ok = recovered.valid;
            value.barcode_recovered = recovered.recovered;
        }
    }

    // Per-location seeding columns (all optional)
    const onHand = parseQty(pick('on_hand'));
    if (onHand !== null) value.on_hand = onHand;
    const minPoint = parseQty(pick('min_point'));
    if (minPoint !== null) value.min_point = minPoint;
    const maxPoint = parseQty(pick('max_point'));
    if (maxPoint !== null) value.max_point = maxPoint;
    const reorderQty = parseQty(pick('reorder_qty'));
    if (reorderQty !== null) value.reorder_qty = reorderQty;
    const bin = pick('bin_location');
    if (bin) value.bin_location = str(bin);

    if (value.min_point !== undefined && value.max_point !== undefined && value.max_point < value.min_point) {
        return { ok: false, error: `Max (${value.max_point}) is below min (${value.min_point}) for ${value.sku}` };
    }

    return { ok: true, value };
}

// ============================================================
// MOVEMENT ARITHMETIC
// ============================================================

/**
 * Convert a user-entered quantity into the signed ledger delta.
 *
 * `count` is special: the user enters what they physically counted, and the
 * ledger records the difference from the system's current on-hand, so the
 * running sum still equals reality and the correction is visible.
 *
 * @param {string} movementType
 * @param {number} qty user-entered quantity
 * @param {number} currentOnHand needed for absolute types
 * @returns {{ok: true, delta: number} | {ok: false, error: string}}
 */
function movementDelta(movementType, qty, currentOnHand = 0) {
    const spec = MOVEMENT_TYPES[movementType];
    if (!spec) return { ok: false, error: `Unknown movement type "${movementType}"` };

    const n = Number(qty);
    if (!Number.isFinite(n)) return { ok: false, error: 'Quantity must be a number' };
    if (Math.abs(n) > 1000000) return { ok: false, error: 'Quantity is out of range' };

    if (spec.absolute) {
        if (n < 0) return { ok: false, error: 'A counted quantity cannot be negative' };
        const delta = round4(n - Number(currentOnHand || 0));
        if (delta === 0) return { ok: false, error: 'Counted quantity matches on-hand — nothing to post' };
        return { ok: true, delta };
    }

    if (movementType === 'adjust') {
        if (n === 0) return { ok: false, error: 'Adjustment cannot be zero' };
        return { ok: true, delta: round4(n) };
    }

    if (n <= 0) return { ok: false, error: 'Quantity must be greater than zero' };
    return { ok: true, delta: round4(n * spec.sign) };
}

/** Guard against float drift on fractional units (litres, kilos). */
function round4(n) {
    return Math.round(Number(n) * 10000) / 10000;
}

// ============================================================
// REPLENISHMENT
// ============================================================

/**
 * Should this level trigger a replenishment line, and for how much?
 *
 * Rule: when on-hand falls to or below the minimum, order back up to the max.
 * If no max is set, fall back to the explicit reorder quantity, then to
 * "enough to reach the minimum, but at least one".
 *
 * Quantities are rounded up to whole units — you cannot order 2.4 cans.
 *
 * @param {{on_hand:number, min_point:?number, max_point:?number, reorder_qty:?number, is_tracked:?boolean}} level
 * @returns {{trigger: boolean, qty: number, reason: string}}
 */
function replenishmentFor(level) {
    const onHand = Number(level?.on_hand ?? 0);
    const min = level?.min_point === null || level?.min_point === undefined ? null : Number(level.min_point);
    const max = level?.max_point === null || level?.max_point === undefined ? null : Number(level.max_point);
    const reorderQty = level?.reorder_qty === null || level?.reorder_qty === undefined ? null : Number(level.reorder_qty);

    if (level?.is_tracked === false) return { trigger: false, qty: 0, reason: 'not tracked' };
    if (min === null || !Number.isFinite(min)) return { trigger: false, qty: 0, reason: 'no minimum set' };
    if (onHand > min) return { trigger: false, qty: 0, reason: 'above minimum' };

    let qty;
    let reason;
    if (max !== null && Number.isFinite(max) && max > onHand) {
        qty = max - onHand;
        reason = `on-hand ${trimNum(onHand)} at or below min ${trimNum(min)} — ordering up to max ${trimNum(max)}`;
    } else if (reorderQty !== null && Number.isFinite(reorderQty) && reorderQty > 0) {
        qty = reorderQty;
        reason = `on-hand ${trimNum(onHand)} at or below min ${trimNum(min)} — fixed reorder quantity`;
    } else {
        qty = Math.max(min - onHand, 1);
        reason = `on-hand ${trimNum(onHand)} at or below min ${trimNum(min)} — topping up to minimum`;
    }

    qty = Math.ceil(round4(qty));
    if (qty <= 0) return { trigger: false, qty: 0, reason: 'nothing to order' };
    return { trigger: true, qty, reason };
}

/** Render a number without trailing zeros: 3.0 -> "3", 2.50 -> "2.5". */
function trimNum(n) {
    const v = round4(n);
    return Number.isInteger(v) ? String(v) : String(v);
}

/**
 * Classify a level for the dashboard.
 * Mirrors the CASE expression in the inventory_status view — keep the two in
 * step if either changes.
 */
function stockStatus(level) {
    if (level?.is_tracked === false) return 'untracked';
    const onHand = Number(level?.on_hand ?? 0);
    if (onHand <= 0) return 'out';
    const min = level?.min_point;
    if (min !== null && min !== undefined && onHand <= Number(min)) return 'low';
    return 'ok';
}

// ============================================================
// COMPANY SETTINGS
// ============================================================

const DEFAULT_INVENTORY_SETTINGS = {
    enabled: false,
    auto_draft: true,          // auto-add replenishment lines when stock hits min
    require_approval: true,    // a manager must approve before it becomes a CHC order
    alert_emails: [],          // extra recipients for low-stock alerts
    allow_negative: false,     // block consuming more than is on hand
    scan_sound: true
};

/**
 * Read the inventory block out of companies.settings with defaults applied.
 * @param {Object} companySettings the raw jsonb value
 */
function inventorySettings(companySettings) {
    const raw = (companySettings && typeof companySettings === 'object' && companySettings.inventory) || {};
    return {
        ...DEFAULT_INVENTORY_SETTINGS,
        ...raw,
        alert_emails: Array.isArray(raw.alert_emails) ? raw.alert_emails : []
    };
}

module.exports = {
    MOVEMENT_TYPES,
    MOVEMENT_TYPE_NAMES,
    STORE_MOVEMENT_TYPES,
    DEFAULT_INVENTORY_SETTINGS,
    cleanBarcode,
    canonicalBarcode,
    barcodeVariants,
    detectSymbology,
    gs1CheckDigit,
    isValidGs1,
    recoverGs1,
    parseMoney,
    parseQty,
    headerKey,
    normalizeMasterRow,
    movementDelta,
    replenishmentFor,
    stockStatus,
    inventorySettings,
    round4
};
