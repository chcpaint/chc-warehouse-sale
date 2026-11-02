/**
 * utils/sheet-detect.js
 *
 * Reading a price list without being told what its columns are.
 *
 * Vendors and distributors each export their own layout: different heading
 * names ("Part Number", "Your Net", "Desc."), headings below a title block or
 * missing altogether, semicolon- or tab-separated files, European decimal
 * commas, and descriptions with unquoted commas that push every later cell one
 * column to the right ("columns not aligning"). This module works out, from the
 * headings AND from what is actually in each column, which column is the part
 * number, the product name and the price -- and repairs rows that drifted.
 *
 * Nothing here talks to a database or the network. Every function is pure so
 * each rule can be tested on its own.
 *
 * The rule that matters most: it never invents a price. A column is only used
 * as the price when its values really are prices. If it cannot tell, it says so
 * (ok: false) and hands back the columns so a person can point at the right one.
 */

const ROLES = ['sku', 'name', 'price', 'previous_price', 'brand', 'category', 'description', 'unit', 'case_qty', 'image_url'];
// Order matters: earlier roles pick their column first, so a lone "Description"
// column becomes the product name rather than an optional description.
const ASSIGN_ORDER = ['sku', 'name', 'price', 'previous_price', 'brand', 'category', 'description', 'unit', 'case_qty', 'image_url'];

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/** "$1,234.50", " 3.69 ", "CAD 12", 12.5  ->  number. Anything else -> NaN. Never guesses. */
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

// "3,69" or "1.234,50": a comma followed by one or two digits at the very end
// can only be a decimal comma (a thousands comma is always followed by three).
const DECIMAL_COMMA = /^\s*[$€]?\s*(\d{1,3}(\.\d{3})+|\d+),(\d{1,2})\s*$/;
const fixDecimalComma = v => (typeof v === 'string' && DECIMAL_COMMA.test(v))
    ? v.replace(/[$€\s]/g, '').replace(/\./g, '').replace(',', '.')
    : v;

// ---------------------------------------------------------------------------
// Text, delimiters, CSV
// ---------------------------------------------------------------------------

/** Buffer -> string: honours a BOM, tries UTF-8, falls back to Windows-1252 (Excel "CSV" on Windows). */
function decodeText(buffer) {
    if (typeof buffer === 'string') return buffer.replace(/^﻿/, '');
    const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) return b.slice(2).toString('utf16le');
    if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) return Buffer.from(b.slice(2)).swap16().toString('utf16le');
    if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return b.slice(3).toString('utf8');
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(b);
    } catch (_) {
        try { return new TextDecoder('windows-1252').decode(b); } catch (__) { return b.toString('latin1'); }
    }
}

/**
 * RFC 4180 CSV, lenient the way spreadsheets are: a quote only opens a quoted
 * field at the start of a field (so 3" Tape stays 3" Tape), "" is a quote, and
 * a quoted field may span lines unless multiline is false.
 */
function parseDelimited(text, delim = ',', multiline = true) {
    const rows = [];
    let row = [];
    let field = '';
    let inQ = false;
    let quoted = false;
    const n = text.length;
    const pushField = () => { row.push(field); field = ''; quoted = false; };
    const pushRow = () => { pushField(); rows.push(row); row = []; };
    for (let i = 0; i < n; i++) {
        const ch = text[i];
        if (inQ) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; continue; }
                inQ = false; continue;
            }
            if (multiline || (ch !== '\n' && ch !== '\r')) { field += ch; continue; }
            inQ = false;                                   // an unclosed quote ends with its line
        }
        if (ch === '"' && !quoted && field.trim() === '') { inQ = true; quoted = true; field = ''; continue; }
        if (ch === delim) { pushField(); continue; }
        if (ch === '\r' || ch === '\n') {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            pushRow();
            continue;
        }
        field += ch;
    }
    if (field !== '' || row.length) pushRow();
    return rows;
}

/** Comma, semicolon, tab or pipe -- whichever splits the lines into the most consistent columns. */
function sniffDelimiter(text) {
    const lines = text.split(/\r\n|\n|\r/).filter(l => l.trim() !== '').slice(0, 60);
    let best = ',';
    let bestScore = -1;
    for (const d of [',', ';', '\t', '|']) {
        const freq = new Map();
        for (const l of lines) {
            const c = parseDelimited(l, d, false)[0].length;
            if (c >= 2) freq.set(c, (freq.get(c) || 0) + 1);
        }
        let mode = 0, modeLines = 0;
        for (const [c, f] of freq) if (f > modeLines || (f === modeLines && c > mode)) { mode = c; modeLines = f; }
        const score = modeLines * 1000 + mode;
        if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
}

/** Text of a CSV/TSV/etc. file -> grid of strings. An unclosed quote cannot swallow the rest of the file. */
function csvToMatrix(text, delim) {
    const d = delim || sniffDelimiter(text);
    let grid = parseDelimited(text, d, true);
    const lineCount = text.split(/\r\n|\n|\r/).length;
    const huge = grid.some(r => r.some(c => c.length > 4000));
    if (huge || (lineCount > 20 && grid.length < lineCount * 0.5)) grid = parseDelimited(text, d, false);
    return { grid, delimiter: d };
}

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

const norm = v => String(v == null ? '' : v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/#/g, 'no').replace(/[^a-z0-9]+/g, '');

const SKU_EXACT = {
    sku: 100, itemsku: 100, partsku: 100, itemno: 100, itemnumber: 100, partno: 100, partnumber: 100, partnum: 100,
    productcode: 95, productno: 95, productnumber: 95, itemcode: 95, partcode: 95, itemid: 85, productid: 85, partid: 85,
    catalogno: 90, catalognumber: 90, stockno: 90, stocknumber: 90, stockcode: 90, materialno: 90, materialnumber: 90,
    part: 90, material: 80, article: 80, model: 70, modelno: 80, code: 60, number: 60, id: 55, ref: 55, reference: 55,
    upc: 50, ean: 50, gtin: 50, barcode: 50, upccode: 50,
    artikel: 95, artikelnr: 100, artikelnummer: 100, numero: 90, reference: 55, refno: 60, numrodarticle: 90
};
const SKU_RE = /^(item|part|product|prod|catalog|catalogue|stock|material|article|model|sku)(no|num|number|nbr|code|id)$/;
const SKU_VENDOR_RE = /^(mfg|mfr|manufacturer|vendor|supplier)(part|item|product|sku)(no|num|number|nbr|code)?$/;

const NAME_EXACT = {
    itemname: 100, name: 100, productname: 100, product: 100, partname: 100, itemtitle: 100, title: 100, producttitle: 100,
    item: 90, partdescription: 60, description: 60, desc: 60, descr: 60, itemdescription: 60, itemdesc: 60,
    productdescription: 60, longdescription: 60, details: 55,
    bezeichnung: 100, beschreibung: 60, designation: 100, descripcion: 60, nombre: 100
};
const DESC_EXACT = {
    description: 100, itemdescription: 100, productdescription: 100, desc: 100, descr: 100, itemdesc: 100,
    longdescription: 100, details: 100, partdescription: 100
};
const BRAND_EXACT = { brand: 100, brandname: 100, manufacturer: 100, manufacturername: 100, mfg: 100, mfr: 100, make: 100 };
const CATEGORY_EXACT = {
    category: 100, categoryname: 100, cat: 100, type: 100, producttype: 100, group: 100, productgroup: 100,
    productline: 100, customlistno1: 100, department: 100, class: 100, family: 100
};
const UNIT_EXACT = { unit: 100, uom: 100, unitofmeasure: 100, unitofmeas: 100, um: 100 };
const CASEQTY_EXACT = {
    casequantity: 100, caseqty: 100, qtypercase: 100, packsize: 100, packqty: 100, pack: 100, qtycase: 100, casesize: 100
};
const IMAGE_EXACT = { imageurl: 100, image: 100, photo: 100, picture: 100, imagelink: 100, photourl: 100 };

/** 'sell' | 'list' | 'cost' | null for a normalised heading that talks about money. */
function priceKind(n) {
    if (!n || n.length > 28) return null;
    if (/(qty|quantity|case|pack|discount|disc|percent|pct|tax|margin|markup|weight|count|vendor|supplier)/.test(n)) return null;
    if (/(msrp|rrp)/.test(n) || /^(list|retail|regular|suggested|was|old|previous|original|base)(price|cost|amount|amt)?$/.test(n)
        || /(list|retail|regular|suggested|previous|was|old|original)price$/.test(n)) return 'list';
    if (/(cost|buy|purchase|landed)/.test(n)) return 'cost';
    if (/price/.test(n) || /^(net|sell|sale|selling|dealer|wholesale|customer|your|contract|current|new|unit|each|ea|yournet|dealernet|customernet|preis|prix|precio)(price|amt|amount)?$/.test(n)
        || /^(amount|amt)$/.test(n)) return 'sell';
    return null;
}

/** Every role a heading could be naming, with how strongly. */
function headerCandidates(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw || raw.length > 40) return [];
    const n = norm(raw);
    if (!n || /^\d+(\.\d+)?$/.test(n)) return [];
    const out = [];
    const add = (role, score) => out.push({ role, score });

    if (SKU_EXACT[n]) add('sku', SKU_EXACT[n]);
    else if (SKU_RE.test(n)) add('sku', 95);
    else if (SKU_VENDOR_RE.test(n)) add('sku', 80);
    if (NAME_EXACT[n]) add('name', NAME_EXACT[n]);
    if (DESC_EXACT[n]) add('description', DESC_EXACT[n]);
    if (BRAND_EXACT[n]) add('brand', BRAND_EXACT[n]);
    if (CATEGORY_EXACT[n]) add('category', CATEGORY_EXACT[n]);
    if (UNIT_EXACT[n]) add('unit', UNIT_EXACT[n]);
    if (CASEQTY_EXACT[n]) add('case_qty', CASEQTY_EXACT[n]);
    if (IMAGE_EXACT[n]) add('image_url', IMAGE_EXACT[n]);

    const kind = priceKind(n);
    if (kind === 'sell') add('price', n === 'warehousesaleprice' ? 110 : n === 'price' ? 100 : 90);
    if (kind === 'list') { add('price', 60); add('previous_price', 100); }
    if (kind === 'cost') add('price', 40);
    return out;
}

/** Index of the heading row, or -1 when the file has none. */
function findHeaderIndex(matrix, limit = 60) {
    const top = Math.min(matrix.length, limit);
    let best = -1, bestHits = 0;
    for (let i = 0; i < top; i++) {
        const cells = matrix[i] || [];
        const filled = cells.filter(c => String(c == null ? '' : c).trim() !== '');
        if (filled.length < 2) continue;
        const hits = cells.filter(c => headerCandidates(c).length > 0).length;
        if (hits >= 2) return i;                          // first row that names two or more things
        if (hits === 1 && bestHits === 0 && filled.every(c => Number.isNaN(parsePrice(c)))) { best = i; bestHits = 1; }
    }
    // One recognisable heading and nothing numeric on that row: take it only if
    // the next filled row looks like data (has a price-like number).
    if (best >= 0) {
        for (let j = best + 1; j < Math.min(matrix.length, best + 6); j++) {
            const next = (matrix[j] || []).filter(c => String(c == null ? '' : c).trim() !== '');
            if (next.length >= 2) return next.some(c => !Number.isNaN(parsePrice(c))) ? best : -1;
        }
    }
    return -1;
}

// ---------------------------------------------------------------------------
// Column contents
// ---------------------------------------------------------------------------

const cellStr = v => (v === undefined || v === null) ? '' : String(v).trim();
const SKU_LIKE = /^[A-Za-z0-9][A-Za-z0-9\-_./#]{1,29}$/;

function columnStats(dataRows, c, decimalCommaOk = true) {
    const vals = [];
    for (let i = 0; i < dataRows.length && vals.length < 400; i++) {
        const s = cellStr(dataRows[i][c]);
        if (s !== '') vals.push(s);
    }
    const n = vals.length;
    const total = Math.max(1, Math.min(dataRows.length, 400));
    const st = { n, fill: n / total, posFrac: 0, numFrac: 0, decFrac: 0, spaceFrac: 0, alphaFrac: 0, skuFrac: 0, uniq: 0, avgLen: 0, idLike: false, commaDecimal: false };
    if (!n) return st;
    let pos = 0, num = 0, dec = 0, space = 0, alpha = 0, sku = 0, len = 0, lead0 = 0, commaDec = 0;
    for (const v of vals) {
        const cd = decimalCommaOk && DECIMAL_COMMA.test(v);
        const p = parsePrice(cd ? fixDecimalComma(v) : v);
        if (Number.isFinite(p)) {
            num++;
            if (p > 0) pos++;
            if (/[.,]\d{1,2}\s*$/.test(v)) dec++;
            if (/^0\d+$/.test(v)) lead0++;
            if (cd) commaDec++;
        }
        if (/\s/.test(v)) space++;
        if (/[A-Za-z]/.test(v)) alpha++;
        if (SKU_LIKE.test(v) && /\d/.test(v)) sku++;
        len += v.length;
    }
    st.posFrac = pos / n;
    st.numFrac = num / n; st.decFrac = dec / n; st.spaceFrac = space / n; st.alphaFrac = alpha / n;
    st.skuFrac = sku / n; st.avgLen = len / n; st.uniq = new Set(vals).size / n;
    st.commaDecimal = commaDec / n >= 0.5;
    // 05916, 1000234 ... a column of whole numbers that never repeats is an id, not money
    st.idLike = (st.uniq >= 0.9 && st.decFrac < 0.05 && n >= 3) || lead0 / n > 0.2;
    return st;
}

/** How well a column's CONTENT fits a role (0 = neutral, negative = contradicts). */
function contentFit(role, st) {
    if (role === 'price' || role === 'previous_price') {
        if (!st.n) return -80;
        if (st.numFrac < 0.5) return -80;
        return 20 * st.numFrac + 15 * st.decFrac - (st.idLike ? 50 : 0);
    }
    if (role === 'sku') {
        if (!st.n) return -60;
        if (st.skuFrac < 0.7) return -30;
        return 20 * st.skuFrac + 15 * st.uniq;
    }
    if (role === 'name') {
        if (!st.n) return -60;
        if (st.numFrac > 0.8) return -80;
        if (st.spaceFrac >= 0.4 && st.alphaFrac >= 0.7) return 10 + Math.min(st.avgLen, 60) / 3;
        if (st.avgLen < 8 && st.spaceFrac < 0.3) return -30;
        return 0;
    }
    return 0;
}

/** Could this column be this role judged on content alone (no usable heading)? */
function contentOnly(role, st) {
    if (!st.n || st.fill < 0.5) return 0;
    if (role === 'price') return (st.numFrac >= 0.8 && st.posFrac >= 0.5 && st.decFrac >= 0.3 && !st.idLike) ? 30 + 15 * st.decFrac : 0;
    if (role === 'sku') return (st.skuFrac >= 0.85 && st.uniq >= 0.8 && st.spaceFrac < 0.1 && !(st.numFrac > 0.8 && st.decFrac > 0.3)) ? 20 + 20 * st.uniq : 0;
    if (role === 'name') return (st.avgLen >= 6 && st.spaceFrac >= 0.5 && st.alphaFrac >= 0.9) ? 20 + Math.min(st.avgLen, 60) / 3 : 0;
    return 0;
}

// ---------------------------------------------------------------------------
// Choosing the columns
// ---------------------------------------------------------------------------

/**
 * headers: array of heading texts ('' where there is none); stats: per-column
 * stats; shift: the heading for column j is headers[j - shift] (corrects a
 * heading row that is offset from its data).
 */
function assignColumns({ headers, stats, ncols, shift = 0, manual = null }) {
    const mapping = {};
    const sources = {};
    const used = new Set();
    const headerAt = j => headers[j - shift];
    let fitness = 0;

    for (const role of ASSIGN_ORDER) {
        if (manual && Object.prototype.hasOwnProperty.call(manual, role)) {
            const idx = manual[role];
            if (idx === null || idx === undefined) continue;
            if (idx >= 0 && idx < ncols && !used.has(idx)) { mapping[role] = idx; sources[role] = 'manual'; used.add(idx); }
            continue;
        }
        let bestCol = -1, bestScore = 0, bestSource = 'header';
        for (let j = 0; j < ncols; j++) {
            if (used.has(j)) continue;
            const st = stats[j];
            const cand = headerCandidates(headerAt(j)).find(x => x.role === role);
            let score = 0, source = 'header';
            if (cand) {
                score = cand.score + contentFit(role, st);
                if (score < 30) score = 0;
            } else if (role === 'price' || role === 'sku' || role === 'name') {
                score = contentOnly(role, st);
                if (score < 20) score = 0;
                source = 'content';
                // A column that is plainly named as something else is not a candidate
                if (score && headerCandidates(headerAt(j)).some(x => x.role !== role && x.score >= 90)) score = 0;
            }
            if (score > bestScore) { bestScore = score; bestCol = j; bestSource = source; }
        }
        if (bestCol >= 0) {
            mapping[role] = bestCol; sources[role] = bestSource; used.add(bestCol);
            if (role === 'sku' || role === 'name' || role === 'price') fitness += contentFit(role, stats[bestCol]);
        }
    }
    return { mapping, sources, fitness };
}

/** Does any heading-derived choice contradict what the column actually holds? */
function hasContradiction(mapping, sources, stats) {
    return ['sku', 'name', 'price'].some(r => mapping[r] === undefined ? false : sources[r] === 'header' && contentFit(r, stats[mapping[r]]) < 0)
        || mapping.price === undefined || mapping.name === undefined;
}

// ---------------------------------------------------------------------------
// The whole sheet
// ---------------------------------------------------------------------------

function trimRight(cells) {
    let end = cells.length;
    while (end > 0 && cellStr(cells[end - 1]) === '') end--;
    return end === cells.length ? cells : cells.slice(0, end);
}

/**
 * Work out the layout of a grid of cells and return one object per product row.
 *
 * opts.columnMap  { role: columnIndex | null } -- a person's choice, wins over detection
 * opts.fmtMatrix  the same grid as displayed text (Excel), used to keep a part number's leading zeros
 *
 * Returns { ok, rows, headerRow, mapping, sources, columns, repaired, warnings, missing, skippedNoName }.
 * Each row has the heading names as keys (for display), a hidden __row (the line number the
 * person sees) and a hidden __v holding the value for each role.
 */
function readSheet(matrix, opts = {}) {
    const result = { ok: false, noPrice: false, rows: [], preview: [], headerRow: 0, mapping: {}, sources: {}, columns: [], repaired: 0, warnings: [], missing: [], skippedNoName: 0 };
    if (!matrix || !matrix.length) { result.missing = ['name', 'price']; return result; }

    // A person can say where the headings are (1-based line; 0 = there are none).
    const hOpt = Number.isInteger(opts.headerRow) && opts.headerRow >= 0 && opts.headerRow <= matrix.length ? opts.headerRow - 1 : null;
    const h = hOpt !== null ? hOpt : findHeaderIndex(matrix);
    const headerCells = h >= 0 ? trimRight((matrix[h] || []).map(c => cellStr(c))) : [];
    const start = h + 1;

    // data lines
    const lines = [];
    for (let i = start; i < matrix.length; i++) {
        const cells = trimRight((matrix[i] || []).map(c => (c === undefined || c === null) ? '' : (typeof c === 'number' ? c : String(c))));
        if (!cells.some(c => cellStr(c) !== '')) continue;                 // blank line
        lines.push({ i, cells });
    }
    if (!lines.length) { result.headerRow = h + 1; result.missing = ['name', 'price']; return result; }

    // ---- lines pushed right by unquoted commas, when the headings say where the numbers belong ----
    // (If EVERY description has a comma, the data is uniformly wider than the heading and the
    // usual "most lines are normal" reasoning would take the wrong width.)
    let preRepaired = 0;
    if (h >= 0 && headerCells.length >= 2) {
        const hl = headerCells.length;
        const roleOf = j => (headerCandidates(headerCells[j]).sort((x, y) => y.score - x.score)[0] || {}).role;
        const numericCols = [];
        for (let j = 0; j < hl; j++) if (['price', 'previous_price', 'case_qty'].includes(roleOf(j)) && !/^(unit|uom)$/i.test(headerCells[j])) numericCols.push(j);
        if (numericCols.length) {
            const rank = j => { const r = roleOf(j); return r === 'name' ? 0 : r === 'description' ? 1 : (r === undefined ? 2 : 3); };
            const mergeOrder = Array.from({ length: hl }, (_, j) => j).filter(j => !numericCols.includes(j)).sort((a, b) => rank(a) - rank(b) || a - b);
            const wide = lines.filter(l => l.cells.length > hl);
            if (wide.length) {
                const fixed = [];
                for (const l of wide) {
                    const extra = l.cells.length - hl;
                    for (const p of mergeOrder) {
                        if (p + extra >= l.cells.length) continue;
                        const merged = l.cells.slice(0, p).concat([l.cells.slice(p, p + extra + 1).map(c => String(c)).join(',')], l.cells.slice(p + extra + 1));
                        const good = numericCols.every(c => cellStr(merged[c]) === '' || Number.isFinite(parsePrice(fixDecimalComma(cellStr(merged[c])))));
                        if (good && numericCols.some(c => cellStr(merged[c]) !== '')) { fixed.push([l, merged]); break; }
                    }
                }
                // only trust it when it explains most of the oversize lines
                // ...and when the part-number column still holds part numbers afterwards. If it now holds
                // 1, 2, 3 the lines are not "comma in the name" but a heading that is offset from its data.
                const skuCol = Array.from({ length: hl }, (_, j) => j).find(j => roleOf(j) === 'sku');
                const skuStillOk = skuCol === undefined || fixed.length === 0 || (fixed.filter(([, m]) => {
                    const v = cellStr(m[skuCol]);
                    return SKU_LIKE.test(v) && /\d/.test(v) && !/^\d{1,3}$/.test(v);
                }).length / fixed.length) >= 0.7;
                if (skuStillOk && fixed.length >= Math.max(1, Math.ceil(wide.length * 0.6))) {
                    fixed.forEach(([l, merged]) => { l.cells = merged; });
                    preRepaired = fixed.length;
                }
            }
        }
    }

    result.repaired = preRepaired;
    // width
    const freq = new Map();
    lines.forEach(l => freq.set(l.cells.length, (freq.get(l.cells.length) || 0) + 1));
    let modal = 0, modalN = 0;
    for (const [w, f] of freq) if (f > modalN || (f === modalN && w > modal)) { modal = w; modalN = f; }
    let ncols = headerCells.length || modal;
    const widest = Math.max(...lines.map(l => l.cells.length));
    if (h >= 0 && modal > ncols && modalN >= lines.length * 0.5) ncols = modal;   // most rows are wider than the heading
    const headers = Array.from({ length: Math.max(ncols, headerCells.length) }, (_, j) => headerCells[j] || '');
    const totalCols = Math.max(ncols, headers.length);

    // stats come from rows that already fit; ragged ones are repaired afterwards
    let sample = lines.filter(l => l.cells.length <= ncols && l.cells.length >= Math.min(ncols, modal)).map(l => l.cells);
    if (sample.length < 3) sample = lines.map(l => l.cells);
    const stats = Array.from({ length: totalCols }, (_, j) => columnStats(sample, j));

    let manual = null;
    if (opts.columnMap && typeof opts.columnMap === 'object') {
        manual = {};
        for (const [role, idx] of Object.entries(opts.columnMap)) {
            if (!ROLES.includes(role)) continue;
            manual[role] = (idx === null || idx === '' || idx === undefined) ? null : Number(idx);
            if (manual[role] !== null && !Number.isInteger(manual[role])) delete manual[role];
        }
    }

    let pick = assignColumns({ headers, stats, ncols: totalCols, manual });
    let shiftUsed = 0;
    if (!manual && h >= 0 && hasContradiction(pick.mapping, pick.sources, stats)) {
        // The heading row may sit offset from its data (an extra leading column on one side).
        for (const s of [1, -1, 2, -2, 3, -3]) {
            const alt = assignColumns({ headers, stats, ncols: totalCols, shift: s });
            if (alt.mapping.price !== undefined && alt.mapping.name !== undefined
                && !hasContradiction(alt.mapping, alt.sources, stats) && alt.fitness > pick.fitness + 20) {
                pick = alt; shiftUsed = s; break;
            }
        }
        if (shiftUsed) result.warnings.push(`The headings looked ${Math.abs(shiftUsed)} column${Math.abs(shiftUsed) === 1 ? '' : 's'} ${shiftUsed > 0 ? 'left' : 'right'} of their data; matched them up by content.`);
    }
    const { mapping, sources } = pick;
    result.mapping = mapping; result.sources = sources; result.headerRow = h + 1;

    // columns for the UI: heading + three examples
    result.columns = Array.from({ length: Math.min(totalCols, 60) }, (_, j) => ({
        index: j,
        header: headers[j - shiftUsed] || headers[j] || '',
        samples: sample.map(r => cellStr(r[j])).filter(Boolean).slice(0, 3)
    }));
    // with a shift the heading shown is the one that now belongs to the column
    if (shiftUsed) result.columns.forEach(c => { c.header = headers[c.index - shiftUsed] || ''; });

    // the first few lines as they sit in the file, so a person can see the layout
    result.preview = lines.slice(0, 12).map(l => ({ row: l.i + 1, cells: Array.from({ length: Math.min(totalCols, 60) }, (_, j) => cellStr(l.cells[j]).slice(0, 80)) }));
    // A file with no price heading and no price-like column at all (e.g. an accounting "new items"
    // import, where every price is $0.00) can still be read: the products are identified by part
    // number and priced from the master list afterwards. A price heading over unusable values is
    // different -- that needs a person to look.
    const hasPriceHeading = headers.some(t => headerCandidates(t).some(c => c.role === 'price'));
    result.noPrice = mapping.price === undefined && mapping.name !== undefined && mapping.sku !== undefined && !hasPriceHeading;
    result.missing = ['name', 'price'].filter(r => mapping[r] === undefined && !(r === 'price' && result.noPrice));
    if (result.missing.length) return result;
    result.preview = [];                                              // rebuilt below from the realigned lines

    const decComma = ['price', 'previous_price'].filter(r => mapping[r] !== undefined && stats[mapping[r]].commaDecimal);
    const fix = (role, v) => decComma.includes(role) ? fixDecimalComma(v) : v;

    // ---- repair rows pushed right by unquoted commas -------------------------
    const textCols = [];
    [mapping.name, mapping.description, mapping.brand, mapping.category].forEach(c => { if (c !== undefined) textCols.push(c); });
    for (let j = 0; j < ncols; j++) if (!Object.values(mapping).includes(j)) textCols.push(j);
    const priceOk = cells => {
        const p = parsePrice(fix('price', cellStr(cells[mapping.price])));
        if (!Number.isFinite(p)) return false;
        if (mapping.previous_price !== undefined && cellStr(cells[mapping.previous_price]) !== ''
            && !Number.isFinite(parsePrice(fix('previous_price', cellStr(cells[mapping.previous_price]))))) return false;
        if (mapping.sku !== undefined && /\s/.test(cellStr(cells[mapping.sku])) && !/\s/.test(cellStr(sample[0] && sample[0][mapping.sku]))) return false;
        return true;
    };
    const repair = cells => {
        const extra = cells.length - ncols;
        if (extra <= 0) return cells;
        if (priceOk(cells) && extra <= 0) return cells;
        for (const p of textCols) {
            if (p + extra >= cells.length) continue;
            const merged = cells.slice(0, p).concat([cells.slice(p, p + extra + 1).map(c => String(c)).join(',')], cells.slice(p + extra + 1));
            if (merged.length === ncols && priceOk(merged)) { result.repaired++; return merged; }
        }
        return cells;                                                  // could not repair: the row will say why
    };

    // ---- build the rows --------------------------------------------------------
    const dupe = {};
    const keys = headers.map((name, j) => {
        const base = (shiftUsed ? headers[j - shiftUsed] : name) || '';
        if (!base) return '';
        dupe[base] = (dupe[base] || 0) + 1;
        return dupe[base] > 1 ? `${base} (${dupe[base]})` : base;
    });
    const fmt = opts.fmtMatrix || null;
    for (const line of lines) {
        const cells = repair(line.cells);
        const v = {};
        for (const [role, idx] of Object.entries(mapping)) {
            let val = cells[idx];
            if (role === 'sku' && typeof val === 'number') {
                const f = fmt && fmt[line.i] ? cellStr(fmt[line.i][idx]) : '';
                val = (Number.isInteger(val) && /^0\d+$/.test(f)) ? f : String(val);
            }
            val = (val === undefined || val === null) ? '' : val;
            if (typeof val === 'string') val = val.trim();
            if ((role === 'price' || role === 'previous_price') && typeof val === 'string') val = fix(role, val);
            if (val !== '') v[role] = val;
        }
        if (result.preview.length < 12) result.preview.push({ row: line.i + 1, cells: Array.from({ length: Math.min(totalCols, 60) }, (_, j) => cellStr(cells[j]).slice(0, 80)) });
        if (v.name === undefined || String(v.name).trim() === '') { result.skippedNoName++; continue; }   // totals, notes
        const obj = {};
        keys.forEach((k, j) => { if (k && cellStr(cells[j]) !== '') obj[k] = cells[j]; });
        Object.defineProperty(obj, '__row', { value: line.i + 1, enumerable: false });
        Object.defineProperty(obj, '__v', { value: v, enumerable: false });
        result.rows.push(obj);
    }
    if (widest > ncols && result.repaired === 0 && lines.some(l => l.cells.length > ncols)) {
        result.warnings.push('Some lines had more cells than the heading; the extra cells were ignored.');
    }
    if (result.repaired) result.warnings.push(`${result.repaired} line${result.repaired === 1 ? '' : 's'} had a stray comma in the text and ${result.repaired === 1 ? 'was' : 'were'} realigned.`);
    if (result.noPrice) result.warnings.push('This file has no prices. Items are matched by part number and priced from the master list where it has them; the rest are skipped.');
    if (sources.price === 'content') result.warnings.push('No price heading was found; the price column was picked from its numbers. Check it before applying.');
    if (h < 0) result.warnings.push('No heading row was found; columns were identified from their contents.');
    result.ok = result.rows.length > 0;
    return result;
}

module.exports = {
    ROLES, parsePrice, fixDecimalComma, decodeText, parseDelimited, sniffDelimiter, csvToMatrix,
    headerCandidates, findHeaderIndex, columnStats, readSheet
};
