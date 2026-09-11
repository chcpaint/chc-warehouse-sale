/**
 * tests/order-status.test.js
 *
 * Pure logic: which statuses a distributor's dropdown offers, and what label
 * an order gets, per the CHC staff-meeting request (Received / Out for
 * Delivery / Partial Shipment with Backorder / Closed for CHC; the full set
 * for everyone else) — and the pricing-visibility stripping that backs the
 * "packing slip" toggle. No stubbing needed: both modules are pure functions
 * over plain objects.
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    ALL_STATUSES, isSimplified, statusOptionsFor, labelFor, PARTIAL_SHIPMENT_LABEL
} = require('../utils/order-status');

const { hidePricingEnabled, stripOrderPricing, stripItemsPricing } = require('../utils/pricing-visibility');

// ==================================================================
// isSimplified / statusOptionsFor
// ==================================================================

test('no distributor settings at all means the full status set', () => {
    assert.equal(isSimplified(null), false);
    assert.equal(isSimplified(undefined), false);
    assert.equal(isSimplified({}), false);
    const opts = statusOptionsFor(null);
    assert.deepEqual(opts.map(o => o.value), ALL_STATUSES);
});

test('order_status_mode "simplified" drops processing but keeps cancelled', () => {
    const settings = { order_status_mode: 'simplified' };
    assert.equal(isSimplified(settings), true);
    const opts = statusOptionsFor(settings);
    assert.deepEqual(opts.map(o => o.value), ['pending', 'out_on_delivery', 'closed', 'cancelled']);
});

test('simplified labels match the staff-meeting wording', () => {
    const opts = statusOptionsFor({ order_status_mode: 'simplified' });
    const byValue = Object.fromEntries(opts.map(o => [o.value, o.label]));
    assert.equal(byValue.pending, 'Received');
    assert.equal(byValue.out_on_delivery, 'Out for Delivery');
    assert.equal(byValue.closed, 'Closed');
});

test('a value other than "simplified" is treated as the full set, not a crash', () => {
    assert.equal(isSimplified({ order_status_mode: 'something_else' }), false);
    assert.equal(statusOptionsFor({ order_status_mode: 'something_else' }).length, ALL_STATUSES.length);
});

// ==================================================================
// labelFor
// ==================================================================

test('a plain out_on_delivery order is labelled per the distributor\'s mode', () => {
    assert.equal(labelFor('out_on_delivery', false, { order_status_mode: 'simplified' }), 'Out for Delivery');
    assert.equal(labelFor('out_on_delivery', false, null), 'Out on Delivery');
});

test('the partial-shipment flag overrides the label regardless of mode', () => {
    assert.equal(labelFor('out_on_delivery', true, { order_status_mode: 'simplified' }), PARTIAL_SHIPMENT_LABEL);
    assert.equal(labelFor('out_on_delivery', true, null), PARTIAL_SHIPMENT_LABEL,
        'a full-set distributor that sets the flag still gets the partial-shipment wording — it is not CHC-only behaviour');
});

test('the partial flag has no effect on any other status', () => {
    assert.equal(labelFor('closed', true, { order_status_mode: 'simplified' }), 'Closed');
    assert.equal(labelFor('pending', true, { order_status_mode: 'simplified' }), 'Received');
});

test('pending is relabelled "Received" only in simplified mode', () => {
    assert.equal(labelFor('pending', false, { order_status_mode: 'simplified' }), 'Received');
    assert.equal(labelFor('pending', false, null), 'Pending');
});

// ==================================================================
// pricing-visibility
// ==================================================================

test('hidePricingEnabled reads the module registry, off by default', () => {
    assert.equal(hidePricingEnabled(null), false);
    assert.equal(hidePricingEnabled({}), false);
    assert.equal(hidePricingEnabled({ hide_pricing: { enabled: false } }), false);
    assert.equal(hidePricingEnabled({ hide_pricing: { enabled: true } }), true);
});

test('stripOrderPricing removes every dollar figure but keeps items, status, and notes', () => {
    const order = {
        id: 'o1', status: 'out_on_delivery', notes: 'leave at the back door',
        subtotal: 100, tax: 13, tax_rate: 0.13, delivery_fee: 10, total: 123,
        items: [{ name: 'Widget', sku: 'W-1', quantity: 2, unit_price: 50, subtotal: 100, price_on_request: false }]
    };
    const stripped = stripOrderPricing(order);
    assert.equal(stripped.subtotal, null);
    assert.equal(stripped.tax, null);
    assert.equal(stripped.tax_rate, null);
    assert.equal(stripped.delivery_fee, null);
    assert.equal(stripped.total, null);
    assert.equal(stripped.pricing_hidden, true);
    assert.equal(stripped.status, 'out_on_delivery');
    assert.equal(stripped.notes, 'leave at the back door');
    assert.equal(stripped.items[0].name, 'Widget');
    assert.equal(stripped.items[0].quantity, 2);
    assert.equal(stripped.items[0].unit_price, null);
    assert.equal(stripped.items[0].subtotal, null);
});

test('stripItemsPricing tolerates a missing or non-array items list', () => {
    assert.deepEqual(stripItemsPricing(undefined), []);
    assert.deepEqual(stripItemsPricing(null), []);
});
