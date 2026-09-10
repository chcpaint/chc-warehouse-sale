/**
 * tests/delivery-fee.test.js
 *
 * The $10-under-$300 delivery fee — pure logic, tested the same way
 * utils/tax.js is: exhaustively here, with no database involved.
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const fee = require('../utils/delivery-fee');

// ==================================================================
// DEFAULTS
// ==================================================================

test('a company with no delivery-fee settings at all is charged the fee', () => {
    const s = fee.deliveryFeeSettings(undefined);
    assert.equal(s.enabled, true);
});

test('a company with settings but no delivery_fee block still defaults to on', () => {
    const s = fee.deliveryFeeSettings({ purchase_orders: { mode: 'off' } });
    assert.equal(s.enabled, true);
});

test('only an explicit false turns it off', () => {
    assert.equal(fee.deliveryFeeSettings({ delivery_fee: {} }).enabled, true);
    assert.equal(fee.deliveryFeeSettings({ delivery_fee: { enabled: true } }).enabled, true);
    assert.equal(fee.deliveryFeeSettings({ delivery_fee: { enabled: false } }).enabled, false);
});

// ==================================================================
// COMPUTING THE FEE
// ==================================================================

test('an order under $300 is charged the $10 fee', () => {
    assert.equal(fee.computeDeliveryFee(299.99, { delivery_fee: {} }), 10);
    assert.equal(fee.computeDeliveryFee(0, { delivery_fee: {} }), 10);
});

test('an order at exactly $300 is not charged the fee — the threshold is "under", not "at or under"', () => {
    assert.equal(fee.computeDeliveryFee(300, { delivery_fee: {} }), 0);
});

test('an order over $300 is not charged the fee', () => {
    assert.equal(fee.computeDeliveryFee(300.01, { delivery_fee: {} }), 0);
    assert.equal(fee.computeDeliveryFee(5000, { delivery_fee: {} }), 0);
});

test('a company with the fee turned off is never charged it, regardless of order size', () => {
    assert.equal(fee.computeDeliveryFee(1, { delivery_fee: { enabled: false } }), 0);
    assert.equal(fee.computeDeliveryFee(0, { delivery_fee: { enabled: false } }), 0);
});

test('a missing or zero subtotal is charged the fee, not treated as NaN', () => {
    assert.equal(fee.computeDeliveryFee(undefined, { delivery_fee: {} }), 10);
    assert.equal(fee.computeDeliveryFee(null, { delivery_fee: {} }), 10);
});

test('a bare boolean is accepted as "enabled" directly, without resolving settings twice', () => {
    assert.equal(fee.computeDeliveryFee(100, true), 10);
    assert.equal(fee.computeDeliveryFee(100, false), 0);
    assert.equal(fee.computeDeliveryFee(500, true), 0);
});

test('THRESHOLD and FEE are exported for callers (email, cart preview) that need to display them', () => {
    assert.equal(fee.THRESHOLD, 300);
    assert.equal(fee.FEE, 10);
});
