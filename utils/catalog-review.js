/**
 * utils/catalog-review.js
 *
 * When a manufacturer's catalog arrives, three things look alike to a naive
 * importer and must not be confused:
 *
 *   NEW       a part the company has never had
 *   RENAMED   a part it already has (same part number) that the manufacturer
 *             has re-worded -- the identity is the part number, so this is an
 *             update to the name, never a second product
 *   SAME-ITEM-NEW-NUMBER
 *             an item whose NAME matches something already in the catalog
 *             under a DIFFERENT part number -- either a duplicate being added
 *             by mistake or a part number the manufacturer changed. Only a
 *             person can say which, so it is held for a decision.
 *
 * Pure functions: no database, so each rule is testable on its own.
 */

/** MMM-06652, mmm06652 and "MMM 06652" are the same part. */
const skuKey = v => String(v == null ? '' : v).replace(/[^A-Za-z0-9]/g, '').toUpperCase();

const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'for', 'with', 'in', 'to', '3m', 'pack', 'each', 'ea']);

/** Lower-case words of a product name, punctuation dropped; sizes like 3in / P80 / 310ml stay whole. */
function nameTokens(name) {
    return String(name == null ? '' : name)
        .toLowerCase()
        .replace(/[‘’]/g, "'")
        .replace(/(\d)\s*(?:"|in\.?\b)/g, '$1in ')             // 3" == 3in
        .replace(/[^a-z0-9.]+/g, ' ')
        .split(/\s+/)
        .map(t => t.replace(/^\.+|\.+$/g, ''))
        .filter(t => t && !STOP.has(t));
}

const numericSignature = tokens => tokens.filter(t => /\d/.test(t)).sort().join('|');

/** "same wording" for the purpose of deciding a name was NOT really changed. */
const nameKey = name => nameTokens(name).join(' ');

function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    return inter / (a.size + b.size - inter);
}

/**
 * Index a company's existing products for fast matching.
 * products: [{ id, sku, name, price, price_on_request, ... }]
 */
function buildIndex(products) {
    const bySku = new Map();            // sku_key -> product
    const byNameKey = new Map();        // exact normalised wording -> [product]
    const byNumSig = new Map();         // numeric signature -> [{p, set}]
    for (const p of products || []) {
        const k = skuKey(p.sku);
        if (k && !bySku.has(k)) bySku.set(k, p);
        const toks = nameTokens(p.name);
        if (!toks.length) continue;
        const nk = toks.join(' ');
        if (!byNameKey.has(nk)) byNameKey.set(nk, []);
        byNameKey.get(nk).push(p);
        const sig = numericSignature(toks);
        if (!byNumSig.has(sig)) byNumSig.set(sig, []);
        byNumSig.get(sig).push({ p, set: new Set(toks) });
    }
    return { bySku, byNameKey, byNumSig };
}

/**
 * What is this incoming row, relative to what the company already has?
 *   { type: 'match', existing, renamed }                    same part number
 *   { type: 'possible_duplicate', matches: [existing...] }  same item, different number
 *   { type: 'new' }
 * Items that differ in a size / grit / volume are never "the same item", however
 * alike the wording (P80 vs P120, 310mL vs 400mL).
 */
function classify(row, index, { threshold = 0.85, maxBucket = 3000, maxMatches = 3 } = {}) {
    const k = skuKey(row.sku);
    if (k && index.bySku.has(k)) {
        const existing = index.bySku.get(k);
        const renamed = nameKey(existing.name) !== nameKey(row.name);
        return { type: 'match', existing, renamed };
    }
    const toks = nameTokens(row.name);
    if (!toks.length) return { type: 'new' };
    const found = new Map();
    for (const p of index.byNameKey.get(toks.join(' ')) || []) {
        if (skuKey(p.sku) !== k) found.set(p.id || p.sku, p);
    }
    if (!found.size) {
        const bucket = index.byNumSig.get(numericSignature(toks)) || [];
        if (bucket.length <= maxBucket) {
            const set = new Set(toks);
            for (const { p, set: ps } of bucket) {
                if (skuKey(p.sku) === k) continue;
                if (jaccard(set, ps) >= threshold) found.set(p.id || p.sku, p);
            }
        }
    }
    if (found.size) return { type: 'possible_duplicate', matches: [...found.values()].slice(0, maxMatches) };
    return { type: 'new' };
}

module.exports = { skuKey, nameTokens, nameKey, buildIndex, classify, jaccard };
