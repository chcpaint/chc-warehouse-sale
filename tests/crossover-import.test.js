/**
 * tests/crossover-import.test.js
 *
 * The brand-crossover parser is pure and has no database or file I/O, so it
 * is tested directly against small handwritten grids shaped exactly like the
 * real workbook's two layouts, rather than against the real .xlsx (which
 * lives outside the repo and would make this test depend on a file nobody
 * here can see).
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCrossoverGrid, splitCombined, suggestCrossoverAlternatives } = require('../utils/crossover-import');

const STANDARD = { altBrand: '3M', altLine: '3M Automix / Duramix', layout: 'standard' };
const COMBINED = { altBrand: 'Kent', altLine: 'Kent', layout: 'combined' };

function grid(rows) {
    // Row 0 (title) and row 1 (header) are always skipped by the parser.
    return [['title'], ['header'], ...rows];
}

test('a plain row with both sides filled becomes one crossover row', () => {
    const rows = parseCrossoverGrid(grid([
        ['Metal Bonding Adhesive', 'Fusor 208B', 'Slow', '210ml', 'Panel Bonding Adhesive', '08115', 'Slow', '200ml']
    ]), STANDARD);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].base_part_number, 'Fusor 208B');
    assert.equal(rows[0].alt_brand, '3M');
    assert.equal(rows[0].alt_part_number, '08115');
});

test('a category banner is remembered and attached to the rows under it', () => {
    const rows = parseCrossoverGrid(grid([
        ['METAL BONDING ADHESIVES'],
        ['Metal Bonding Adhesive', 'Fusor 208B', 'Slow', '210ml', 'Panel Bond', '08115', 'Slow', '200ml']
    ]), STANDARD);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].base_category, 'METAL BONDING ADHESIVES');
});

test('a row with a blank base carries the previous base forward', () => {
    const rows = parseCrossoverGrid(grid([
        ['Metal Bonding Adhesive', 'Fusor 208B', 'Slow', '210ml', 'Multi-Purpose Panel Bond', '6421', 'Slow', '220ml'],
        [null, null, null, null, 'Multi-Purpose Panel Bond', '6418', 'Slow', '220ml']
    ]), STANDARD);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].base_part_number, 'Fusor 208B');
    assert.equal(rows[1].base_part_number, 'Fusor 208B', 'the second alternative belongs to the same Fusor part');
    assert.equal(rows[1].alt_part_number, '6418');
});

test('a base part with no alternative offered is not a crossover row', () => {
    const rows = parseCrossoverGrid(grid([
        ['Metal Bonding Adhesive', 'Fusor 110B/111B', 'Fast', '210ml/50ml']
    ]), STANDARD);
    assert.equal(rows.length, 0);
});

test('a row cannot anchor to nothing when no base has ever been seen', () => {
    const rows = parseCrossoverGrid(grid([
        [null, null, null, null, 'Stray alt with no base', '999', 'Fast', '1 oz']
    ]), STANDARD);
    assert.equal(rows.length, 0);
});

test('the combined layout splits a trailing part number out of the name', () => {
    const rows = parseCrossoverGrid(grid([
        ['Metal Bonding Adhesive', 'Fusor 112B/113B', 'Medium/Slow', '210ml/50ml', 'Panel Adhesive (2:1) KT12638', 'Slow', '7 oz']
    ]), COMBINED);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].alt_name, 'Panel Adhesive (2:1)');
    assert.equal(rows[0].alt_part_number, 'KT12638');
    assert.equal(rows[0].alt_size, '7 oz');
});

test('the combined layout keeps multiple trailing part numbers together', () => {
    const rows = parseCrossoverGrid(grid([
        ['Direct To Metal Seam Sealer', 'Fusor 800DTM', '1K', '296ml', 'Quick Seal P10552, P10556, KT13437', 'Slow', '10.3 oz']
    ]), COMBINED);
    assert.equal(rows[0].alt_name, 'Quick Seal');
    assert.equal(rows[0].alt_part_number, 'P10552, P10556, KT13437');
});

test('a combined name with no recognisable part number is kept whole with a null part', () => {
    assert.deepEqual(splitCombined('No Equivalent'), { name: 'No Equivalent', part: null });
    assert.deepEqual(splitCombined(null), { name: null, part: null });
});

test('an all-digit part number is recognised in the combined layout too', () => {
    const rows = parseCrossoverGrid(grid([
        ['Metal Bonding Adhesive', 'Fusor 112B/113B', 'Medium/Slow', '210ml/50ml', 'Power Panel Bond 0893450100', 'Slow', '7.4 oz']
    ]), COMBINED);
    assert.equal(rows[0].alt_name, 'Power Panel Bond');
    assert.equal(rows[0].alt_part_number, '0893450100');
});

// ==================================================================
// SUGGESTING ALTERNATIVES FOR A KIT LINE (pure)
// ==================================================================

const REFERENCE = [
    { id: 'r1', base_part_number: 'Fusor 208B', alt_brand: 'Norton', alt_part_number: '06421' },
    { id: 'r2', base_part_number: 'Fusor 2098 Crash Durable Structural Adhesive', alt_brand: '3M', alt_part_number: '07333' },
    { id: 'r3', base_part_number: 'Fusor 123EZ/126EZ', alt_brand: 'SEM', alt_part_number: '39377' },
    { id: 'r4', base_part_number: 'Fusor 130', alt_brand: 'Kent', alt_part_number: 'P10612' },
    { id: 'r5', base_part_number: 'Fusor 141/140', alt_brand: 'Wurth', alt_part_number: '0893301917' }
];

test('a kit SKU matching a base part exactly (after stripping the brand prefix) ranks first', () => {
    const out = suggestCrossoverAlternatives('FUS208B', REFERENCE);
    assert.equal(out[0].id, 'r1');
    assert.equal(out[0].score, 100);
});

test('a base part with extra descriptive words after the number still matches', () => {
    const out = suggestCrossoverAlternatives('FUS2098', REFERENCE);
    assert.equal(out[0].id, 'r2');
});

test('a slash-joined pair of Fusor codes matches either one', () => {
    const out = suggestCrossoverAlternatives('FUS123EZ', REFERENCE);
    assert.equal(out[0].id, 'r3');
});

test('a kit SKU with an extra size suffix still finds the base part as a weaker match', () => {
    const out = suggestCrossoverAlternatives('FUS130SM', REFERENCE);
    assert.ok(out.some(o => o.id === 'r4'));
    assert.ok(out.find(o => o.id === 'r4').score < 100);
});

test('an unrelated kit SKU with no plausible base part gets no suggestions', () => {
    assert.deepEqual(suggestCrossoverAlternatives('FUS999ZZ', REFERENCE), []);
});

test('every suggestion carries a reason a person can check', () => {
    for (const s of suggestCrossoverAlternatives('FUS208B', REFERENCE)) {
        assert.ok(typeof s.why === 'string' && s.why.length > 0);
    }
});
