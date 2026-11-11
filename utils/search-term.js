/**
 * utils/search-term.js
 *
 * A typed search box ends up inside a PostgREST `or=(...)` filter, where a
 * comma starts a new condition and brackets open and close groups. Left raw,
 * a search for `x%,is_active.eq.false` becomes a second condition. Tenancy
 * filters are separate and still apply, but a search must only ever be a
 * search, so every term goes through here first.
 *
 * Keeps letters, digits, spaces and the punctuation real part numbers use
 * (. - / # & + '), drops the rest, and caps the length.
 */
function searchTerm(value, max = 60) {
    return String(value == null ? '' : value)
        .normalize('NFKC')
        .replace(/[^\p{L}\p{N} .\-\/#&+']/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

module.exports = { searchTerm };
