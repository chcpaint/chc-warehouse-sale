/**
 * tests/delivery-fee-admin.test.js
 *
 * Who may flip the per-company delivery-fee switch, and who can merely see
 * it. Two independent gates protect the write, the same shape
 * tests/order-roles.test.js checks for the rest of the order-only console:
 *
 *   1. restrictOrderDesk's ORDER_DESK_ALLOW must let order_desk/order_manager
 *      reach the route at all (a reachability gate, not a permission one).
 *   2. canManageDeliveryFee() inside the route itself is the actual
 *      permission — most order_desk accounts are refused even once they can
 *      reach it.
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (parent && request.startsWith('.')) {
        const resolved = path.resolve(path.dirname(parent.filename), request);
        if (resolved === path.join(ROOT, 'utils/supabase') || resolved === path.join(ROOT, 'utils/supabase.js')) {
            return { supabaseAdmin: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) } };
        }
    }
    return originalLoad.call(this, request, parent, isMain);
};

const auth = require('../middleware/auth');
const { canManageDeliveryFee } = require('../routes/delivery-fee-admin');

// ==================================================================
// REACHABILITY — restrictOrderDesk's allow-list
// ==================================================================

function reach(role, method, urlPath) {
    let passed = false, status = null;
    const req = { admin: { role, must_change_password: false }, method, path: urlPath };
    const res = { status: (c) => { status = c; return res; }, json: () => {} };
    auth.restrictOrderDesk(req, res, () => { passed = true; });
    return { passed, status };
}

test('both order-only roles can reach the delivery-fee route on the Orders screen', () => {
    for (const role of ['order_desk', 'order_manager']) {
        assert.equal(reach(role, 'GET', '/companies/abc/delivery-fee').passed, true, role);
        assert.equal(reach(role, 'PUT', '/companies/abc/delivery-fee').passed, true, role);
    }
});

test('reaching the route is not the same as being allowed to write — that is canManageDeliveryFee()', () => {
    // A plain order-desk counter account (Carlos, Eric, Assad, Sujit, Lucas —
    // not flagged is_branch_manager) reaches the route fine...
    assert.equal(reach('order_desk', 'PUT', '/companies/abc/delivery-fee').passed, true);
    // ...but the permission check inside the route still refuses it.
    assert.equal(canManageDeliveryFee({ role: 'order_desk', is_branch_manager: false }), false);
});

// ==================================================================
// PERMISSION — canManageDeliveryFee()
// ==================================================================

test('a super admin can always manage it', () => {
    assert.equal(canManageDeliveryFee({ role: 'super_admin' }), true);
});

test('an order manager can always manage it — already trusted with every branch\'s orders', () => {
    assert.equal(canManageDeliveryFee({ role: 'order_manager' }), true);
});

test('an order_desk account flagged is_branch_manager can manage it (Francesco, Frank G)', () => {
    assert.equal(canManageDeliveryFee({ role: 'order_desk', is_branch_manager: true }), true);
});

test('a plain order_desk account cannot manage it — the majority of order-desk staff', () => {
    assert.equal(canManageDeliveryFee({ role: 'order_desk', is_branch_manager: false }), false);
    assert.equal(canManageDeliveryFee({ role: 'order_desk' }), false);
});

test('is_branch_manager is meaningless for any role other than order_desk, but harmless if set', () => {
    // super_admin/order_manager already qualify by role regardless.
    assert.equal(canManageDeliveryFee({ role: 'super_admin', is_branch_manager: false }), true);
});

test('no admin at all is refused, not thrown', () => {
    assert.equal(canManageDeliveryFee(null), false);
    assert.equal(canManageDeliveryFee(undefined), false);
});
