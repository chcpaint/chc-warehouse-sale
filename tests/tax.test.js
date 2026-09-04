/**
 * tests/tax.test.js
 *
 * Sales tax resolution and computation — pure logic, tested the same way
 * utils/po.js is: exhaustively here, with no database involved.
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const tax = require('../utils/tax');

// ==================================================================
// DEFAULTS
// ==================================================================

test('a company with no tax settings at all gets Ontario HST at 13%', () => {
    const s = tax.taxSettings(undefined);
    assert.equal(s.rate, 0.13);
    assert.equal(s.exempt, false);
    assert.equal(s.is_default, true);
});

test('a company with settings but no tax block still gets the default', () => {
    const s = tax.taxSettings({ purchase_orders: { mode: 'off' } });
    assert.equal(s.rate, 0.13);
    assert.equal(s.is_default, true);
});

test('an explicit rate equal to the default is not reported as "default"', () => {
    // Distinguishing "nobody configured this" from "somebody configured this
    // to 13% on purpose" matters for the admin screen — one should look like
    // an unset field, the other like a deliberate choice.
    const s = tax.taxSettings({ tax: { rate: 0.13 } });
    assert.equal(s.rate, 0.13);
    assert.equal(s.is_default, false);
});

// ==================================================================
// CUSTOM RATE
// ==================================================================

test('a company-specific rate overrides the default', () => {
    const s = tax.taxSettings({ tax: { rate: 0.15 } });
    assert.equal(s.rate, 0.15);
    assert.equal(s.is_default, false);
});

test('a rate of exactly zero is honoured, not treated as unset', () => {
    const s = tax.taxSettings({ tax: { rate: 0 } });
    assert.equal(s.rate, 0);
    assert.equal(s.is_default, false);
});

test('an out-of-range or non-numeric rate falls back to the default rather than taxing nonsense', () => {
    assert.equal(tax.taxSettings({ tax: { rate: 1.5 } }).rate, 0.13);
    assert.equal(tax.taxSettings({ tax: { rate: -0.1 } }).rate, 0.13);
    assert.equal(tax.taxSettings({ tax: { rate: 'thirteen' } }).rate, 0.13);
    assert.equal(tax.taxSettings({ tax: { rate: null } }).rate, 0.13);
});

// ==================================================================
// EXEMPT
// ==================================================================

test('an exempt company is taxed at zero regardless of any rate on file', () => {
    const s = tax.taxSettings({ tax: { exempt: true, rate: 0.15 } });
    assert.equal(s.rate, 0);
    assert.equal(s.exempt, true);
});

test('exempt is not the default state', () => {
    assert.equal(tax.taxSettings(undefined).exempt, false);
});

// ==================================================================
// COMPUTING THE TAX AMOUNT
// ==================================================================

test('13% of a round number computes exactly', () => {
    assert.equal(tax.computeTax(100, { tax: {} }), 13);
    assert.equal(tax.computeTax(1000, { tax: {} }), 130);
});

test('the result is rounded to the cent like real money', () => {
    // 33.33 * 0.13 = 4.3329 -> 4.33
    assert.equal(tax.computeTax(33.33, { tax: {} }), 4.33);
});

test('a zero or missing subtotal taxes to zero, not NaN', () => {
    assert.equal(tax.computeTax(0, { tax: {} }), 0);
    assert.equal(tax.computeTax(undefined, { tax: {} }), 0);
    assert.equal(tax.computeTax(null, { tax: {} }), 0);
});

test('an exempt company computes to zero tax no matter the subtotal', () => {
    assert.equal(tax.computeTax(500, { tax: { exempt: true } }), 0);
});

test('a bare number is accepted as the rate directly, without resolving settings twice', () => {
    assert.equal(tax.computeTax(100, 0.13), 13);
    assert.equal(tax.computeTax(100, 0), 0);
});

// ==================================================================
// VALIDATING A RATE TYPED INTO THE ADMIN CONSOLE
// ==================================================================

test('a valid rate is accepted', () => {
    const r = tax.validateRate('0.13');
    assert.equal(r.ok, true);
    assert.equal(r.rate, 0.13);
});

test('an empty value clears the override rather than being refused', () => {
    for (const v of ['', null, undefined]) {
        const r = tax.validateRate(v);
        assert.equal(r.ok, true, `expected ${JSON.stringify(v)} to be accepted as "clear"`);
        assert.equal(r.rate, undefined);
    }
});

test('zero is a valid, storable rate — not confused with clearing', () => {
    const r = tax.validateRate(0);
    assert.equal(r.ok, true);
    assert.equal(r.rate, 0);
});

test('a rate above 1 (someone typing "13" instead of "0.13") is refused with a helpful message', () => {
    const r = tax.validateRate(13);
    assert.equal(r.ok, false);
    assert.match(r.error, /between 0 and 1/i);
});

test('a negative rate is refused', () => {
    assert.equal(tax.validateRate(-0.05).ok, false);
});

test('a non-numeric rate is refused', () => {
    assert.equal(tax.validateRate('thirteen percent').ok, false);
});
