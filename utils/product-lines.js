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

/**
 * Narrow a products / item_library query to a brand OR a product line.
 *
 * One place, so every screen that offers the drop-down filters the same way:
 * choosing "EHP" must give the same items on the storefront, the Products
 * screen, Customer Pricing and the Item Library. A real brand is an exact
 * match; a line is the "contains" match above.
 */
function applyBrandFilter(query, brand) {
    const line = lineFor(brand);
    return line ? query.or(orFilterFor(line)) : query.eq('brand', brand);
}

/** The search terms of the lines the person ticked (labels in, terms out). Unknown labels are ignored. */
function termsForLabels(labels) {
    const out = [];
    for (const l of Array.isArray(labels) ? labels : String(labels || '').split(',')) {
        const line = lineFor(l);
        if (line) for (const t of line.terms) if (!out.includes(t)) out.push(t);
    }
    return out;
}

/** The lines as the console needs them: a label and the terms that define it. */
function lineDefinitions() {
    return LINES.map(l => ({ label: l.label, terms: [...l.terms] }));
}

module.exports = { LINES, FIELDS, lineFor, orFilterFor, rowInLine, brandOptions, applyBrandFilter, termsForLabels, lineDefinitions };
