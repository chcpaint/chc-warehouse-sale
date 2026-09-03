/**
 * utils/crossover-import.js
 *
 * Parses a brand-crossover workbook -- CHC's own reference for "if a shop
 * wants this in Norton/3M/SEM/Kent/Wurth instead of Fusor, here's the part"
 * -- into flat rows a table can hold. Pure and synchronous: no I/O, no
 * database, so it is exercised directly in tests against a handwritten grid
 * rather than a real .xlsx file.
 *
 * The sheets are laid out as two blocks of columns side by side, base
 * (Fusor) on the left and one competitor brand on the right, one sheet per
 * brand. A row can carry a brand new base part, or just another brand entry
 * for whichever base part came before it (the sheet author left the base
 * columns blank rather than repeat them) -- so the parser has to carry the
 * last base part forward exactly like a merged cell would read visually.
 *
 * Two column shapes exist:
 *   'standard' -- Norton, 3M Duramix, SEM: name/part/speed/size on both sides.
 *   'combined' -- Kent, Wurth: the brand side has no separate part-number
 *                 column; it's folded into the name ("Panel Adhesive (2:1)
 *                 KT12638"), so this parser pulls the trailing part-number-
 *                 looking tokens back out of it.
 *
 * A row that carries no brand-side data at all (Fusor sells this, but the
 * sheet has no equivalent listed) is not a crossover and is skipped -- this
 * table exists to answer "what's the alternative," not to re-list Fusor's
 * own catalogue.
 */

const SHEET_CONFIG = {
    'Norton Speed Grip': { altBrand: 'Norton', altLine: 'Norton SpeedGrip', layout: 'standard' },
    '3M Duramix':         { altBrand: '3M',     altLine: '3M Automix / Duramix', layout: 'standard' },
    'SEM':                { altBrand: 'SEM',    altLine: 'SEM', layout: 'standard' },
    'Kent':                { altBrand: 'Kent',   altLine: 'Kent', layout: 'combined' },
    'Wurth':               { altBrand: 'Wurth',  altLine: 'Wurth', layout: 'combined' }
};

/** A part number token: letter-prefixed (P10611, KT13968) or a bare run of digits (089391020). */
const PART_TOKEN = /\b(?:[A-Za-z]{1,4}\d{3,7}|\d{5,12})\b/g;

function cell(row, i) {
    const v = row[i];
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
}

/** "Panel Adhesive (2:1) KT12638" -> { name: "Panel Adhesive (2:1)", part: "KT12638" }. */
function splitCombined(raw) {
    if (!raw) return { name: null, part: null };
    const tokens = raw.match(PART_TOKEN) || [];
    if (tokens.length === 0) return { name: raw, part: null };

    let name = raw;
    for (const t of tokens) name = name.split(t).join(' ');
    name = name.replace(/[,&/]+/g, ' ').replace(/\s{2,}/g, ' ').trim().replace(/[\s,]+$/, '') || null;

    return { name, part: tokens.join(', ') };
}

/**
 * Parse one sheet's grid (array-of-arrays, header:1 shape) into crossover rows.
 * Assumes row 0 is the sheet title and row 1 is the column header, matching
 * every sheet in the source workbook this was built against.
 */
function parseCrossoverGrid(grid, { altBrand, altLine, layout }) {
    const out = [];
    let category = null;
    let lastBase = { name: null, part: null, speed: null, size: null };

    for (const row of (grid || []).slice(2)) {
        if (!row || row.length === 0) continue;

        const a = cell(row, 0), b = cell(row, 1), c = cell(row, 2), d = cell(row, 3);

        // A category banner: only column A has anything in it.
        if (a && b === null && c === null && d === null && cell(row, 4) === null) {
            category = a;
            continue;
        }

        if (b) lastBase = { name: a, part: b, speed: c, size: d };
        if (!lastBase.part) continue;   // nothing to anchor a crossover entry to yet

        let altName, altPart, altSpeed, altSize;
        if (layout === 'combined') {
            const split = splitCombined(cell(row, 4));
            altName = split.name; altPart = split.part;
            altSpeed = cell(row, 5); altSize = cell(row, 6);
        } else {
            altName = cell(row, 4); altPart = cell(row, 5);
            altSpeed = cell(row, 6); altSize = cell(row, 7);
        }

        if (!altName && !altPart) continue;   // Fusor sells this; no equivalent offered here

        out.push({
            base_brand: 'Fusor',
            base_category: category,
            base_name: lastBase.name,
            base_part_number: lastBase.part,
            base_speed: lastBase.speed,
            base_size: lastBase.size,
            alt_brand: altBrand,
            alt_product_line: altLine,
            alt_name: altName,
            alt_part_number: altPart,
            alt_speed: altSpeed,
            alt_size: altSize
        });
    }

    return out;
}

/**
 * Parse every recognised sheet in a workbook already loaded with XLSX.read().
 * Sheets not in SHEET_CONFIG are ignored rather than guessed at.
 */
function parseCrossoverWorkbook(XLSX, workbook, sourceLabel) {
    const rows = [];
    for (const sheetName of workbook.SheetNames) {
        const config = SHEET_CONFIG[sheetName];
        if (!config) continue;
        const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, blankrows: false, raw: false });
        for (const r of parseCrossoverGrid(grid, config)) {
            rows.push({ ...r, sheet_name: sheetName, source_file: sourceLabel || null });
        }
    }
    return rows;
}

/** Uppercase, alphanumeric only -- punctuation and case carry no meaning in a part number. */
function normalizeToken(s) {
    return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** CHC's kit-line SKUs and this sheet's "Fusor ..." labels both name the same base part; strip the brand word so they compare on the number alone. */
function stripBaseBrandPrefix(s) {
    return normalizeToken(s).replace(/^FUSOR/, '').replace(/^FUS/, '');
}

/**
 * Rank this reference sheet's rows as candidate alternatives for one kit
 * line's SKU. Conservative on purpose, same reasoning as suggestProducts in
 * inventory-kits-admin.js: a row is offered only when its base part number
 * plausibly names the same thing, every candidate says why, and nothing is
 * ever attached automatically.
 */
function suggestCrossoverAlternatives(kitSku, referenceRows) {
    const target = stripBaseBrandPrefix(kitSku);
    if (!target) return [];

    const scored = [];
    for (const row of referenceRows || []) {
        const candidate = stripBaseBrandPrefix(row.base_part_number);
        if (!candidate) continue;

        let score = 0, why = null;
        if (candidate === target) {
            score = 100; why = 'Exact part number';
        } else if (candidate.startsWith(target) || target.startsWith(candidate)) {
            score = 70; why = 'Part number matches apart from a suffix';
        } else if (candidate.includes(target) || target.includes(candidate)) {
            score = 40; why = 'Part number contains the other';
        }

        if (score > 0) scored.push({ ...row, score, why });
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, 20);
}

module.exports = {
    parseCrossoverGrid, parseCrossoverWorkbook, splitCombined, SHEET_CONFIG,
    normalizeToken, stripBaseBrandPrefix, suggestCrossoverAlternatives
};
