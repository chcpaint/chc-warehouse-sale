/**
 * tests/catalog-review.test.js -- new vs renamed vs possible duplicate.
 *   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const cr = require('../utils/catalog-review');

const have = [
    { id: '1', sku: 'MMM00344', name: '3M Yellow Spreader 3x4' },
    { id: '2', sku: 'MMM31361', name: '3M Cubitron II Hookit Abrasive Disc P80 3in' },
    { id: '3', sku: 'MMM08362', name: '3M Urethane Seam Sealer Grey 310mL' }
];
const idx = cr.buildIndex(have);

test('same part number is a match; punctuation in the number is ignored; wording changes are flagged as a rename', () => {
    assert.deepEqual([cr.classify({ sku: 'MMM00344', name: '3M Yellow Spreader 3x4' }, idx).type, cr.classify({ sku: 'MMM00344', name: '3M Yellow Spreader 3x4' }, idx).renamed], ['match', false]);
    assert.equal(cr.classify({ sku: 'mmm-00344', name: '3m yellow spreader 3 X 4' }, idx).existing.id, '1');
    assert.equal(cr.classify({ sku: 'MMM00344', name: '3M Yellow Spreader Large' }, idx).renamed, true);
    assert.equal(cr.classify({ sku: 'MMM00344', name: '  3M  YELLOW spreader, 3x4 ' }, idx).renamed, false, 'case, spacing and punctuation are not a rename');
});

test('same wording under another part number is a possible duplicate', () => {
    const c = cr.classify({ sku: 'MMM99999', name: '3M Yellow Spreader 3x4' }, idx);
    assert.equal(c.type, 'possible_duplicate');
    assert.equal(c.matches[0].sku, 'MMM00344');
    assert.equal(cr.classify({ sku: 'MMM99998', name: 'Yellow Spreader 3x4 (3M)' }, idx).type, 'possible_duplicate');
});

test('a different size, grit or volume is a different item', () => {
    assert.equal(cr.classify({ sku: 'MMM31362', name: '3M Cubitron II Hookit Abrasive Disc P120 3in' }, idx).type, 'new');
    assert.equal(cr.classify({ sku: 'MMM08363', name: '3M Urethane Seam Sealer Grey 400mL' }, idx).type, 'new');
});

test('unrelated items are new; blank names do not crash', () => {
    assert.equal(cr.classify({ sku: 'X1', name: 'Totally unrelated masking tape' }, idx).type, 'new');
    assert.equal(cr.classify({ sku: 'X2', name: '' }, idx).type, 'new');
    assert.equal(cr.classify({ sku: '', name: 'Totally unrelated masking tape' }, cr.buildIndex([])).type, 'new');
});

test('a row without a part number can still be recognised as a duplicate by name', () => {
    assert.equal(cr.classify({ sku: '', name: '3M Yellow Spreader 3x4' }, idx).type, 'possible_duplicate');
});
