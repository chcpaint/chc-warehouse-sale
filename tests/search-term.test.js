/**
 * tests/search-term.test.js -- a search box can only ever be a search.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { searchTerm } = require('../utils/search-term');

test('real part numbers and names survive', () => {
    assert.equal(searchTerm('AL84-0314'), 'AL84-0314');
    assert.equal(searchTerm('JC830/01'), 'JC830/01');
    assert.equal(searchTerm('3M #2 Wetordry P1500'), '3M #2 Wetordry P1500');
    assert.equal(searchTerm("Farecla G3 Reg'r"), "Farecla G3 Reg'r");
    assert.equal(searchTerm('Pâte à polir'), 'Pâte à polir');
});

test('filter syntax is removed: no new conditions, no groups, no wildcards', () => {
    for (const attack of ['x%,is_active.eq.false', 'a),or(company_id.neq.0', 'x*', '"quoted"', 'a\\b']) {
        const out = searchTerm(attack);
        assert.ok(!/[,()%*"\\]/.test(out), `${attack} -> ${out}`);
    }
    assert.equal(searchTerm('x%,is_active.eq.false'), 'x is active.eq.false', 'underscore is a LIKE wildcard too');
});

test('empty, null and very long input', () => {
    assert.equal(searchTerm(null), '');
    assert.equal(searchTerm('   '), '');
    assert.equal(searchTerm('a'.repeat(500)).length, 60);
    assert.equal(searchTerm('abc', 2), 'ab');
});
