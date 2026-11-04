/**
 * Product lines for the storefront brand drop-down.
 *
 * EHP, Shopline and OneChoice are PPG lines. In most catalogues they sit under
 * the brand "PPG" (the line is in the item's name, category or part number), so
 * the plain brand list never offered them. A line is listed beside the real
 * brands, and choosing it shows every item that belongs to it, whatever brand
 * the item is filed under.
 *
 * The match is deliberately simple (a case-insensitive "contains" on the item's
 * brand, category, name and part number) so the database filter and the
 * drop-down list are guaranteed to agree: the same terms drive both.
 */

const LINES = [
    { label: 'EHP',       terms: ['ehp'] },
    { label: 'OneChoice', terms: ['onechoice', 'one choice', 'one-choice'] },
    { label: 'Shopline',  terms: ['shopline', 'shop line', 'shop-line'] }
];

const FIELDS = ['brand', 'category', 'name', 'sku'];

/** The line a drop-down value names, or null when it is an ordinary brand. */
function lineFor(value) {
    const v = String(value || '').trim().toLowerCase();
    return LINES.find(l => l.label.toLowerCase() === v) || null;
}

/** PostgREST .or() string selecting the items of a line. */
function orFilterFor(line) {
    const parts = [];
    for (const f of FIELDS) {
        for (const t of line.terms) parts.push(`${f}.ilike.%${t}%`);
    }
    return parts.join(',');
}

/** Does this item row (brand/category/name/sku) belong to the line? */
function rowInLine(row, line) {
    const hay = FIELDS.map(f => String((row && row[f]) || '').toLowerCase());
    return line.terms.some(t => hay.some(h => h.includes(t)));
}

/**
 * The drop-down list: the real brands plus every line that has at least one
 * item, sorted together. A real brand that carries a line's own name is folded
 * into the line (the line's filter already includes it).
 */
function brandOptions(rows) {
    const brands = new Set();
    for (const r of rows || []) if (r && r.brand) brands.add(r.brand);
    const out = new Set([...brands].filter(b => !lineFor(b)));
    for (const line of LINES) {
        if ((rows || []).some(r => rowInLine(r, line))) out.add(line.label);
    }
    return [...out].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

module.exports = { LINES, lineFor, orFilterFor, rowInLine, brandOptions };
