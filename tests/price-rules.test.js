/**
 * tests/price-rules.test.js
 *
 * The two standing rules from migration 024, as pure logic.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE
 *
 * The rules themselves are database triggers, and a trigger cannot be executed
 * by a stub — the real enforcement is proven against the live database (see
 * qa/README-price-rules.md). What lives here is the *decision*: given a price
 * and a list price, is this refused, recorded, or fine; and given a product
 * name, where should it file itself.
 *
 * That split matters. If someone later widens the block threshold, or teaches
 * the categoriser a new word, these tests say out loud what the old behaviour
 * was and force the change to be deliberate.
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { priceVerdict, suggestCategory } = require('../utils/price-rules');

// ==================================================================
// Rule 1 — the price bands
// ==================================================================

test('a decimal slip is refused', () => {
    // The case that prompted the rule: a $1,250 polisher listed at $119.90.
    assert.equal(priceVerdict(119.90, 1250.99).action, 'refuse');
});

test('the gunwash that was on Concord\'s live list is refused', () => {
    assert.equal(priceVerdict(6.30, 62.99).action, 'refuse');
});

test('a real negotiated deal is accepted without fuss', () => {
    // Louie's $69.99 on the 3M 092 hundred-packs — 0.50 of list, entirely real.
    const v = priceVerdict(69.99, 139.99);
    assert.equal(v.action, 'accept');
    assert.equal(v.record, false,
        'flagging a genuine deal trains people to ignore the queue');
});

test('list price itself is obviously fine', () => {
    assert.equal(priceVerdict(99.99, 99.99).action, 'accept');
});

test('a deep but plausible discount is allowed, and recorded', () => {
    const v = priceVerdict(25.00, 100.00);   // 0.25
    assert.equal(v.action, 'accept');
    assert.equal(v.record, true);
});

test('a case price against a per-unit list is allowed, and recorded', () => {
    // A box of ten filters at ten times the price of one filter is correct,
    // and still worth a human glance.
    const v = priceVerdict(799.60, 79.99);
    assert.equal(v.action, 'accept');
    assert.equal(v.record, true);
});

test('the boundaries are where they are claimed to be', () => {
    assert.equal(priceVerdict(15.00, 100).action, 'accept', '0.15 is the edge, not inside it');
    assert.equal(priceVerdict(14.99, 100).action, 'refuse');
    assert.equal(priceVerdict(29.99, 100).record, true);
    assert.equal(priceVerdict(30.01, 100).record, false);
    assert.equal(priceVerdict(400, 100).record, false);
    assert.equal(priceVerdict(400.01, 100).record, true);
});

test('no list price means no opinion', () => {
    // Most of the catalogue is not in the reference library. The rule must be
    // silent there rather than guessing.
    assert.equal(priceVerdict(5, null).action, 'accept');
    assert.equal(priceVerdict(5, 0).action, 'accept');
    assert.equal(priceVerdict(5, null).record, false);
});

test('a "contact for pricing" line is never judged', () => {
    const v = priceVerdict(0, 99.99, { priceOnRequest: true });
    assert.equal(v.action, 'accept');
    assert.equal(v.record, false);
});

test('a zero price is left to the price_on_request rule, not this one', () => {
    assert.equal(priceVerdict(0, 99.99).action, 'accept');
});

test('the override turns a refusal into a recorded write, never a silent one', () => {
    const v = priceVerdict(6.30, 62.99, { allowOutliers: true });
    assert.equal(v.action, 'accept');
    assert.equal(v.record, true,
        'an override that leaves no trace is the same as no rule');
    assert.equal(v.severity, 'blocked-override');
});

test('the refusal message names the numbers a person needs', () => {
    const v = priceVerdict(6.30, 62.99);
    assert.match(v.message, /6\.30/);
    assert.match(v.message, /62\.99/);
    assert.match(v.message, /10\.0%/);
});

// ==================================================================
// Rule 2 — where a chemical files itself
// ==================================================================

test('the chemistries we moved are recognised', () => {
    for (const name of [
        'Gunwash 5Ga',
        'Final Wash 5Ga',
        'Wax and Grease Remover 5Ga',
        'Water Base Degreaser',
        'Acetone 5Ga',
        'LACQUER THINNER PREMIUM',
        'ISO Alcohol 99% 5Ga',
        'Premium Solvent Cleaner 5Ga',
        'Slow Reducer 5Ga',
        '3M Specialty Adhesive Remover Aerosol'
    ]) {
        assert.equal(suggestCategory(name), 'Solvents/Chemicals', name);
    }
});

test('hardware that merely mentions a chemical is not a chemical', () => {
    for (const name of [
        'Faucet For 18.9L',
        '5 Gallon Pour Spout',
        'SEM Spigot for 5Gal/ Carboy',
        '3M Replacement Outlet Filter',
        'Filter Holder',
        'Electric Sander Hose Assembly'
    ]) {
        assert.equal(suggestCategory(name), null, name);
    }
});

test('an unrelated product is left alone', () => {
    assert.equal(suggestCategory('3M Hookit Gold Abrasive Disc 320, 6 in'), null);
    assert.equal(suggestCategory('Paint Cups 400ml 125 micron 50pcs'), null);
});

// ==================================================================
// The part that protects the shops' own filing
// ==================================================================

test('a category somebody chose is never overwritten', () => {
    // PPG DT1850 is a basecoat reducer, so the categoriser recognises it — but
    // it is filed under Colour on purpose, beside the paint it thins. A painter
    // looks for it there.
    assert.equal(suggestCategory('DT1850 Basecoat Reducer'), 'Solvents/Chemicals');

    const { applyCategory } = require('../utils/price-rules');
    assert.equal(applyCategory('DT1850 Basecoat Reducer', 'Colour'), 'Colour');
    assert.equal(applyCategory('DT1850 Basecoat Reducer', 'Primer/Sealer'), 'Primer/Sealer');
});

test('an empty category, or Misc, is treated as a gap to fill', () => {
    const { applyCategory } = require('../utils/price-rules');
    assert.equal(applyCategory('Gunwash 5Ga', null), 'Solvents/Chemicals');
    assert.equal(applyCategory('Gunwash 5Ga', ''), 'Solvents/Chemicals');
    assert.equal(applyCategory('Gunwash 5Ga', 'Misc'), 'Solvents/Chemicals',
        'Misc is what an importer writes when it has nothing better, not a decision');
});

test('a gap stays a gap when there is nothing sensible to suggest', () => {
    const { applyCategory } = require('../utils/price-rules');
    assert.equal(applyCategory('3M Hookit Gold Abrasive Disc 320', null), null);
    assert.equal(applyCategory('3M Hookit Gold Abrasive Disc 320', 'Misc'), 'Misc');
});
