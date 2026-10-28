/**
 * tests/fee-rules.test.js
 *
 * utils/fee-rules.js: what an order is charged for delivery and fuel.
 *
 *   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fr = require('../utils/fee-rules');

const rule = (o) => ({ id: 'r' + Math.random(), kind: 'delivery', label: 'Delivery fee', calc: 'flat', amount: 10,
    condition: 'always', threshold: null, group_ids: [], is_active: true, ...o });

// ---------- legacy fallback ----------
test('no rules and nothing configured: the old $10-under-$300 fee applies', () => {
    const r = fr.resolveFees({ subtotal: 100, rules: [], settings: {} });
    assert.equal(r.mode, 'legacy');
    assert.equal(r.delivery_fee, 10);
    assert.equal(r.total, 10);
    assert.equal(fr.resolveFees({ subtotal: 300, rules: [], settings: {} }).total, 0);
});
test('no rules and the old switch is off (Assured today): no fees', () => {
    const r = fr.resolveFees({ subtotal: 5, rules: [], settings: { delivery_fee: { enabled: false } } });
    assert.equal(r.total, 0);
    assert.deepEqual(r.lines, []);
});
test('once a company has any rule the old setting is ignored', () => {
    const r = fr.resolveFees({ subtotal: 100, rules: [rule({ is_active: false })], settings: {} });
    assert.equal(r.mode, 'rules');
    assert.equal(r.total, 0, 'a paused rule means no fee, not the legacy fee');
});

// ---------- the examples the business asked for ----------
test('flat $10 per order, every order', () => {
    const r = fr.resolveFees({ subtotal: 999, rules: [rule({ amount: 10 })] });
    assert.equal(r.delivery_fee, 10);
});
test('flat $20 per order', () => {
    assert.equal(fr.resolveFees({ subtotal: 50, rules: [rule({ amount: 20 })] }).total, 20);
});
test('orders below a set amount: charged under, free at and above the amount', () => {
    const rules = [rule({ condition: 'below', threshold: 500, amount: 25 })];
    assert.equal(fr.resolveFees({ subtotal: 499.99, rules }).total, 25);
    assert.equal(fr.resolveFees({ subtotal: 500, rules }).total, 0);
    assert.equal(fr.resolveFees({ subtotal: 1200, rules }).total, 0);
});
test('at_or_above is inclusive', () => {
    const rules = [rule({ kind: 'fuel', condition: 'at_or_above', threshold: 1000, calc: 'flat', amount: 15 })];
    assert.equal(fr.resolveFees({ subtotal: 999.99, rules }).total, 0);
    assert.equal(fr.resolveFees({ subtotal: 1000, rules }).fuel_surcharge, 15);
});
test('a percent fuel surcharge is a percent of the item subtotal, to the cent', () => {
    const r = fr.resolveFees({ subtotal: 123.45, rules: [rule({ kind: 'fuel', label: 'Fuel surcharge', calc: 'percent', amount: 3.5 })] });
    assert.equal(r.fuel_surcharge, 4.32);
    assert.equal(r.delivery_fee, 0);
});
test('delivery and fuel together are separate lines and sum', () => {
    const r = fr.resolveFees({ subtotal: 200, rules: [
        rule({ amount: 10 }),
        rule({ kind: 'fuel', label: 'Fuel surcharge', calc: 'percent', amount: 2 })
    ] });
    assert.equal(r.lines.length, 2);
    assert.equal(r.delivery_fee, 10);
    assert.equal(r.fuel_surcharge, 4);
    assert.equal(r.total, 14);
});

// ---------- user groups ----------
test('a rule limited to a user group only charges people in that group', () => {
    const G = '11111111-1111-4111-8111-111111111111', H = '22222222-2222-4222-8222-222222222222';
    const rules = [rule({ group_ids: [G], amount: 12 })];
    assert.equal(fr.resolveFees({ subtotal: 50, rules, groupId: G }).total, 12);
    assert.equal(fr.resolveFees({ subtotal: 50, rules, groupId: H }).total, 0);
    assert.equal(fr.resolveFees({ subtotal: 50, rules, groupId: null }).total, 0, 'a shared access code has no group');
});

// ---------- paused / zero ----------
test('a paused rule charges nothing; a rule that works out to $0 adds no line', () => {
    assert.equal(fr.resolveFees({ subtotal: 50, rules: [rule({ is_active: false })] }).lines.length, 0);
    assert.equal(fr.resolveFees({ subtotal: 0, rules: [rule({ calc: 'percent', amount: 5 })] }).lines.length, 0);
});

// ---------- validation ----------
test('normalizeFeeRule accepts a good rule and cleans the label', () => {
    const { value, error } = fr.normalizeFeeRule({ kind: 'fuel', calc: 'percent', amount: '4.5', condition: 'below', threshold: '250', label: '  Fuel <b>levy</b> ' });
    assert.equal(error, undefined);
    assert.equal(value.amount, 4.5);
    assert.equal(value.threshold, 250);
    assert.ok(!/[<>]/.test(value.label));
    assert.equal(value.is_active, true);
});
test('normalizeFeeRule defaults the label by kind', () => {
    assert.equal(fr.normalizeFeeRule({ kind: 'delivery', calc: 'flat', amount: 10 }).value.label, 'Delivery fee');
    assert.equal(fr.normalizeFeeRule({ kind: 'fuel', calc: 'flat', amount: 10 }).value.label, 'Fuel surcharge');
});
test('normalizeFeeRule refuses bad input', () => {
    const bad = (o) => assert.ok(fr.normalizeFeeRule(o).error, JSON.stringify(o));
    bad({ kind: 'tax', calc: 'flat', amount: 5 });
    bad({ kind: 'delivery', calc: 'weird', amount: 5 });
    bad({ kind: 'delivery', calc: 'flat', amount: 0 });
    bad({ kind: 'delivery', calc: 'flat', amount: -3 });
    bad({ kind: 'delivery', calc: 'flat', amount: 'abc' });
    bad({ kind: 'delivery', calc: 'percent', amount: 101 });
    bad({ kind: 'delivery', calc: 'flat', amount: 5000 });
    bad({ kind: 'delivery', calc: 'flat', amount: 5, condition: 'below' });
    bad({ kind: 'delivery', calc: 'flat', amount: 5, condition: 'below', threshold: -1 });
    bad({ kind: 'delivery', calc: 'flat', amount: 5, condition: 'sometimes' });
    bad({ kind: 'delivery', calc: 'flat', amount: 5, group_ids: ['not-a-uuid'] });
    bad(null);
});

// ---------- display helpers ----------
test('feeLinesOf prefers the itemised lines, else falls back to the old columns', () => {
    assert.deepEqual(fr.feeLinesOf({ fee_lines: [{ kind: 'fuel', label: 'Fuel surcharge', amount: 4 }] }).map(l => l.amount), [4]);
    const old = fr.feeLinesOf({ delivery_fee: 10 });
    assert.equal(old.length, 1);
    assert.equal(old[0].label, 'Delivery fee');
    assert.deepEqual(fr.feeLinesOf({ delivery_fee: 0, fuel_surcharge: 0 }), []);
    assert.deepEqual(fr.feeLinesOf(null), []);
});
test('publicRulesFor shows a customer only active rules that apply to their group', () => {
    const G = '11111111-1111-4111-8111-111111111111';
    const out = fr.publicRulesFor({ rules: [
        rule({ label: 'A' }), rule({ label: 'B', is_active: false }), rule({ label: 'C', group_ids: [G] })
    ], settings: {}, groupId: null });
    assert.deepEqual(out.map(r => r.label), ['A']);
    assert.equal(fr.publicRulesFor({ rules: [rule({ label: 'C', group_ids: [G] })], settings: {}, groupId: G }).length, 1);
    assert.equal(out[0].id, undefined, 'internal ids are not sent to the storefront');
});
