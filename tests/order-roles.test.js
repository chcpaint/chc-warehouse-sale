/**
 * tests/order-roles.test.js
 *
 * Who may see which orders, and who is locked out of the rest of the console.
 *
 * These are the tests worth having because the failure is silent and expensive:
 * a branch desk that can see another branch's customers, or an account still on
 * a shared starting password wandering into company settings. Neither throws an
 * error — they just quietly work when they should not.
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');

// The scope helpers talk to Supabase for branch locations, so the module is
// loaded against a stub that answers that one question.
const branchLocations = {
    'branch-markham': ['loc-markham-1', 'loc-markham-2'],
    'branch-woodbridge': ['loc-woodbridge-1']
};

const supabaseStub = {
    from: () => ({
        select: () => ({
            eq: (col, val) => ({
                then: (res) => res({ data: (branchLocations[val] || []).map(id => ({ id })) })
            })
        })
    })
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (parent && request.startsWith('.')) {
        const resolved = path.resolve(path.dirname(parent.filename), request);
        if (resolved === path.join(ROOT, 'utils/supabase') ||
            resolved === path.join(ROOT, 'utils/supabase.js')) {
            return { supabaseAdmin: supabaseStub };
        }
    }
    return originalLoad.call(this, request, parent, isMain);
};

const { applyOrderScope } = require('../utils/order-scope');
const auth = require('../middleware/auth');

/** A stand-in for a PostgREST builder that records what was asked of it. */
function fakeQuery() {
    const calls = [];
    const q = {
        calls,
        eq: (col, val) => { calls.push(['eq', col, val]); return q; },
        in: (col, vals) => { calls.push(['in', col, vals]); return q; }
    };
    return q;
}

const reqFor = (role, extra = {}) => ({ admin: { role, ...extra } });

// ==================================================================
// Which orders each role sees
// ==================================================================

test('a branch desk is held to its own branch locations', () => {
    const q = fakeQuery();
    applyOrderScope(q, reqFor('order_desk', { branch_id: 'branch-markham' }),
        ['loc-markham-1', 'loc-markham-2'], undefined);
    assert.deepEqual(q.calls, [['in', 'location_id', ['loc-markham-1', 'loc-markham-2']]]);
});

test('a branch desk with no locations sees nothing, not everything', () => {
    // The important half of this rule. A desk whose branch has no locations —
    // or whose branch was never set — must fall closed.
    const q = fakeQuery();
    applyOrderScope(q, reqFor('order_desk', { branch_id: null }), [], undefined);
    const [[op, col, vals]] = q.calls;
    assert.equal(op, 'in');
    assert.equal(col, 'location_id');
    assert.deepEqual(vals, ['00000000-0000-0000-0000-000000000000'],
        'an empty scope must filter to an impossible id, never be skipped');
});

test('an order manager sees every branch', () => {
    const q = fakeQuery();
    applyOrderScope(q, reqFor('order_manager'), null, undefined);
    assert.deepEqual(q.calls, [], 'no location filter — all branches');
});

test('an order manager can still be narrowed to one company on request', () => {
    const q = fakeQuery();
    applyOrderScope(q, reqFor('order_manager'), null, 'company-1');
    assert.deepEqual(q.calls, [['eq', 'company_id', 'company-1']]);
});

test('a company admin is held to their own company', () => {
    const q = fakeQuery();
    applyOrderScope(q, reqFor('admin', { company_id: 'company-9' }), null, undefined);
    assert.deepEqual(q.calls, [['eq', 'company_id', 'company-9']]);
});

// ==================================================================
// What the order-only roles may reach
// ==================================================================

function reach(role, method, urlPath) {
    let passed = false, status = null, body = null;
    const req = { admin: { role, must_change_password: false }, method, path: urlPath };
    const res = { status: (c) => { status = c; return res; }, json: (b) => { body = b; } };
    auth.restrictOrderDesk(req, res, () => { passed = true; });
    return { passed, status, body };
}

test('both order roles can list orders', () => {
    for (const role of ['order_desk', 'order_manager']) {
        assert.equal(reach(role, 'GET', '/orders').passed, true, role);
    }
});

test('both order roles are refused the rest of the console', () => {
    const off_limits = [
        ['GET', '/companies'], ['GET', '/stats'], ['GET', '/users'],
        ['GET', '/audit-log'], ['POST', '/companies'],
        ['POST', '/companies/abc/products'], ['GET', '/companies/abc/library']
    ];
    for (const role of ['order_desk', 'order_manager']) {
        for (const [m, p] of off_limits) {
            const r = reach(role, m, p);
            assert.equal(r.passed, false, `${role} reached ${m} ${p}`);
            assert.equal(r.status, 403);
        }
    }
});

test('an order manager gets no extra console access for being senior', () => {
    // The whole point of the role: wider ORDERS, identical CONSOLE.
    const paths = [['GET', '/companies'], ['GET', '/users'], ['GET', '/stats']];
    for (const [m, p] of paths) {
        assert.equal(reach('order_desk', m, p).status, reach('order_manager', m, p).status, `${m} ${p}`);
    }
});

test('a super admin passes through untouched', () => {
    assert.equal(reach('super_admin', 'GET', '/companies').passed, true);
});

// ==================================================================
// The forced password change
// ==================================================================

function afterPasswordGate(mustChange, method, urlPath) {
    let passed = false, status = null, body = null;
    const req = { admin: { role: 'order_desk', must_change_password: mustChange }, method, path: urlPath };
    const res = { status: (c) => { status = c; return res; }, json: (b) => { body = b; } };
    auth.requirePasswordCurrent(req, res, () => { passed = true; });
    return { passed, status, body };
}

test('an account on a borrowed password reaches nothing but the way out', () => {
    for (const [m, p] of [['GET', '/orders'], ['PUT', '/orders/x/status'], ['GET', '/companies']]) {
        const r = afterPasswordGate(true, m, p);
        assert.equal(r.passed, false, `${m} ${p} should be blocked`);
        assert.equal(r.status, 403);
        assert.equal(r.body.must_change_password, true,
            'the console needs to know WHY it was refused, or it shows a bare error');
    }
});

test('it can still find out who it is, and change the password', () => {
    assert.equal(afterPasswordGate(true, 'GET', '/whoami').passed, true);
    assert.equal(afterPasswordGate(true, 'PUT', '/me/password').passed, true,
        'blocking this would lock the account out permanently');
});

test('once the flag is cleared, everything opens normally', () => {
    assert.equal(afterPasswordGate(false, 'GET', '/orders').passed, true);
});

test('the password gate is enforced server-side, not by the browser', () => {
    // Same call, same role, only the flag differs. If this ever passes with the
    // flag set, the forced change has become a suggestion.
    assert.equal(afterPasswordGate(true, 'GET', '/orders').passed, false);
    assert.equal(afterPasswordGate(false, 'GET', '/orders').passed, true);
});

test('the change-password route survives the order-desk fence too', () => {
    // Two independent gates guard this route. If either one forgot it, a branch
    // desk could never satisfy the forced change.
    assert.equal(reach('order_desk', 'PUT', '/me/password').passed, true);
    assert.equal(reach('order_manager', 'PUT', '/me/password').passed, true);
});
