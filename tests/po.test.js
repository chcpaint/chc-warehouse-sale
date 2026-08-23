/**
 * tests/po.test.js
 *
 * Purchase-order numbers.
 *
 * The check digit and the mode rules are pure and tested exhaustively here.
 * The two properties that actually matter in production — that two orders can
 * never share a number, and that two simultaneous submits get different ones —
 * belong to a unique index and a row lock, so they are verified against the
 * real database in qa/e2e-po.js rather than pretended at here. A stub that
 * "proves" a race condition is safe proves nothing at all.
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const po = require('../utils/po');

// ==================================================================
// FORMAT
// ==================================================================

test('a number reads in three segments so it survives being read aloud', () => {
    assert.match(po.formatPo('ASR', 42), /^ASR-00042-\d$/);
});

test('the sequence is padded to the configured width', () => {
    assert.match(po.formatPo('ASR', 7, { padWidth: 3 }), /^ASR-007-\d$/);
    assert.match(po.formatPo('ASR', 7, { padWidth: 8 }), /^ASR-00000007-\d$/);
});

test('padding never truncates a number that has outgrown it', () => {
    // Six digits in a five-wide field must stay six digits. Truncating would
    // silently reissue: 100042 and 00042 must never print the same.
    assert.match(po.formatPo('ASR', 100042, { padWidth: 5 }), /^ASR-100042-\d$/);
});

test('the check digit can be turned off for a shop that does not want it', () => {
    assert.equal(po.formatPo('ASR', 42, { checkDigit: false }), 'ASR-00042');
});

test('a prefix is upper-cased however it was typed', () => {
    assert.match(po.formatPo('asr', 42), /^ASR-/);
});

// ==================================================================
// CHECK DIGIT — the reason it exists is typo detection, so test that
// ==================================================================

test('every single-digit error is caught', () => {
    let tested = 0, caught = 0;
    for (let n = 1; n <= 500; n++) {
        const parts = /^(ASR)-(\d+)-(\d)$/.exec(po.formatPo('ASR', n));
        for (let i = 0; i < parts[2].length; i++) {
            for (let d = 0; d <= 9; d++) {
                if (String(d) === parts[2][i]) continue;
                tested++;
                const wrong = `ASR-${parts[2].slice(0, i)}${d}${parts[2].slice(i + 1)}-${parts[3]}`;
                if (po.inspectPo(wrong).status === 'mistyped') caught++;
            }
        }
    }
    assert.equal(caught, tested, `${tested - caught} single-digit errors slipped through`);
});

test('almost every transposition of adjacent digits is caught', () => {
    let tested = 0, caught = 0;
    for (let n = 1; n <= 2000; n++) {
        const parts = /^(ASR)-(\d+)-(\d)$/.exec(po.formatPo('ASR', n));
        for (let i = 0; i < parts[2].length - 1; i++) {
            if (parts[2][i] === parts[2][i + 1]) continue;
            tested++;
            const swapped = parts[2].slice(0, i) + parts[2][i + 1] + parts[2][i] + parts[2].slice(i + 2);
            if (po.inspectPo(`ASR-${swapped}-${parts[3]}`).status === 'mistyped') caught++;
        }
    }
    // Luhn cannot catch a 09 <-> 90 swap. That is a known and accepted limit;
    // asserting a realistic rate rather than 100% keeps the test honest.
    assert.ok(caught / tested > 0.95, `only ${(100 * caught / tested).toFixed(1)}% of transpositions caught`);
});

test('a wrong check digit is reported as mistyped, not as unknown', () => {
    const good = po.formatPo('ASR', 42);
    const wrong = good.slice(0, -1) + ((Number(good.slice(-1)) + 1) % 10);
    const verdict = po.inspectPo(wrong);
    assert.equal(verdict.status, 'mistyped');
    assert.equal(verdict.sequence, 42, 'it should still say which number was probably meant');
});

test('the prefix takes part, so two companies never share a check digit by luck', () => {
    const a = po.formatPo('ASR', 42);
    const b = po.formatPo('BTQ', 42);
    assert.notEqual(a.slice(-1), b.slice(-1),
        'a check digit that ignores the prefix says nothing about whether the prefix was heard right');
});

test('a number we did not issue is reported as somebody else\'s, not as broken', () => {
    for (const foreign of ['123456', 'PO 9912', 'INV-2026-11', '']) {
        assert.equal(po.inspectPo(foreign).status, 'not_ours', `${foreign} misjudged`);
    }
});

test('a well-formed number is not claimed to exist', () => {
    // inspectPo answers "is this shaped like ours and internally consistent",
    // never "is this on an order" — only the database can say that.
    const verdict = po.inspectPo(po.formatPo('ZZZ', 999));
    assert.equal(verdict.status, 'ok');
    assert.equal(verdict.found, undefined);
});

test('case and stray whitespace do not make a different number', () => {
    const issued = po.formatPo('ASR', 42);
    assert.equal(po.normalizePo(`  ${issued.toLowerCase()} `), issued);
    assert.equal(po.inspectPo(` ${issued.toLowerCase()}`).status, 'ok');
});

// ==================================================================
// MODES
// ==================================================================

test('a company nobody configured behaves exactly as it does today', () => {
    const s = po.poSettings({});
    assert.equal(s.mode, 'manual');
    assert.equal(s.required, true,
        'defaulting to anything else would silently change live behaviour for every customer');
});

test('off means the field is not required and nothing is stored', () => {
    const s = { purchase_orders: { mode: 'off' } };
    assert.equal(po.poSettings(s).required, false);

    const decision = po.resolveOrderPo(s, '');
    assert.deepEqual(decision, { ok: true, action: 'none' });
});

test('off ignores a number even if one is sent', () => {
    // A stray PO on a company that does not use them is a half-state that
    // confuses a branch later, so it is dropped rather than stored.
    const decision = po.resolveOrderPo({ purchase_orders: { mode: 'off' } }, 'SOMETHING');
    assert.equal(decision.action, 'none');
    assert.equal(decision.po_number, undefined);
});

test('manual requires the shop to supply one', () => {
    const s = { purchase_orders: { mode: 'manual' } };
    assert.equal(po.resolveOrderPo(s, '').ok, false);
    assert.equal(po.resolveOrderPo(s, '   ').ok, false, 'whitespace is not a purchase order');

    const ok = po.resolveOrderPo(s, ' po-1234 ');
    assert.equal(ok.action, 'manual');
    assert.equal(ok.po_number, 'PO-1234', 'stored normalised so casing cannot dodge the constraint');
});

test('an absurdly long manual number is refused', () => {
    const s = { purchase_orders: { mode: 'manual' } };
    assert.equal(po.resolveOrderPo(s, 'X'.repeat(61)).ok, false);
});

test('generated ignores anything typed and allocates instead', () => {
    const s = { purchase_orders: { mode: 'generated' } };
    const decision = po.resolveOrderPo(s, 'MY-OWN-NUMBER');
    assert.equal(decision.action, 'allocate');
    assert.equal(decision.po_number, undefined,
        'if a typed number could win, the sequence would not be authoritative');
});

test('an unrecognised mode falls back to today\'s behaviour rather than skipping the PO', () => {
    const s = { purchase_orders: { mode: 'whatever' } };
    assert.equal(po.poSettings(s).mode, 'manual');
});

// ==================================================================
// ADMIN VALIDATION
// ==================================================================

test('a prefix must be short, start with a letter, and be alphanumeric', () => {
    for (const good of ['AS', 'ASR', 'ASR26', 'A1B2C3D4']) {
        assert.equal(po.validatePrefix(good).ok, true, `${good} should be allowed`);
    }
    for (const bad of ['', 'A', '1ASR', 'ASR-26', 'ASRTOOLONGX', 'AS R', 'ÀSR']) {
        assert.equal(po.validatePrefix(bad).ok, false, `${bad} should be refused`);
    }
});

test('a prefix is normalised to upper case before it is stored', () => {
    assert.equal(po.validatePrefix(' asr26 ').prefix, 'ASR26');
});

test('the number width is bounded', () => {
    assert.equal(po.validatePadWidth(5).ok, true);
    assert.equal(po.validatePadWidth(2).ok, false);
    assert.equal(po.validatePadWidth(10).ok, false);
    assert.equal(po.validatePadWidth('').padWidth, po.DEFAULT_PAD, 'blank means the default');
});

test('the admin preview shows what a shop will actually see', () => {
    assert.equal(po.exampleFor('ASR', 5, false), 'ASR-00042');
    assert.match(po.exampleFor('ASR', 5, true), /^ASR-00042-\d$/);
});

// ==================================================================
// THE PROPERTY THAT MATTERS MOST
// ==================================================================

test('formatting is deterministic, so the same allocation always prints the same', () => {
    // The check digit is computed in one place precisely so it cannot drift.
    // If this ever fails, previously-issued numbers stop validating.
    for (const n of [1, 42, 999, 100000]) {
        assert.equal(po.formatPo('ASR', n), po.formatPo('ASR', n));
    }
    // Pinned so a refactor of the algorithm is a visible, deliberate change
    // rather than a silent invalidation of every number already in the wild.
    assert.equal(po.formatPo('ASR', 1), 'ASR-00001-6');
    assert.equal(po.formatPo('ASR', 42), 'ASR-00042-0');
});
