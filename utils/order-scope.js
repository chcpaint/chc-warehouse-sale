/**
 * utils/order-scope.js
 *
 * One place that decides which orders an admin may see or touch, so every order
 * endpoint scopes the same way and a branch's order desk can never reach another
 * branch's orders.
 *
 * Three kinds of admin:
 *   - super_admin      : every order.
 *   - company admin    : orders for their own company_id (existing behaviour).
 *   - order_desk       : orders whose delivery location belongs to the CHC
 *                        branch the desk is assigned to (branch_id).
 *   - order_manager    : every order, every branch. Head office. Reaches the
 *                        same order-only endpoints as a desk, never the rest of
 *                        the console — see ORDER_DESK_ALLOW.
 */

const { supabaseAdmin } = require('./supabase');

// A location id that can never exist, used to force an empty result rather than
// accidentally returning everything when a desk has no branch/locations.
const NO_MATCH = '00000000-0000-0000-0000-000000000000';

/** The company_location ids routed to a CHC branch. */
async function branchLocationIds(branchId) {
    if (!branchId) return [];
    const { data } = await supabaseAdmin
        .from('company_locations')
        .select('id')
        .eq('supplier_branch_id', branchId);
    return (data || []).map(r => r.id);
}

/**
 * Resolve any async data the scope needs BEFORE touching the query builder.
 * For an order desk that means its branch's location ids. Returns null for
 * roles that need no pre-fetch.
 *
 * Kept separate from applyOrderScope on purpose: a PostgREST builder is a
 * thenable, so if an async function returned one, `await` would adopt it and
 * execute the query early — returning a result instead of a builder. Fetching
 * ids here (async) and applying the filter there (sync) avoids that trap.
 */
async function orderScopeIds(req) {
    if (req.admin.role === 'order_desk') {
        return branchLocationIds(req.admin.branch_id);
    }
    return null;
}

/**
 * Apply role scoping to a Supabase orders query builder (synchronous).
 * `ids` comes from orderScopeIds(); `companyId` is an optional super-admin
 * filter from the query string.
 */
function applyOrderScope(query, req, ids, companyId) {
    const role = req.admin.role;

    if (role === 'super_admin') {
        return companyId ? query.eq('company_id', companyId) : query;
    }

    // Head office: every branch's orders, but only through the order screens —
    // restrictOrderDesk fences the rest of the console for this role too.
    if (role === 'order_manager') {
        return companyId ? query.eq('company_id', companyId) : query;
    }

    if (role === 'order_desk') {
        return query.in('location_id', (ids && ids.length) ? ids : [NO_MATCH]);
    }

    // Company-scoped admin.
    return query.eq('company_id', req.admin.company_id);
}

/**
 * Is a single order within this admin's scope? Used to guard mutations
 * (status, invoice, close). Returns { ok, code?, order? }.
 */
async function orderInScope(req, orderId) {
    const { data: order } = await supabaseAdmin
        .from('orders')
        .select('id, company_id, location_id')
        .eq('id', orderId)
        .maybeSingle();

    if (!order) return { ok: false, code: 404 };

    const role = req.admin.role;
    if (role === 'super_admin') return { ok: true, order };
    if (role === 'order_manager') return { ok: true, order };

    if (role === 'order_desk') {
        const ids = await branchLocationIds(req.admin.branch_id);
        return ids.includes(order.location_id)
            ? { ok: true, order }
            : { ok: false, code: 403 };
    }

    return order.company_id === req.admin.company_id
        ? { ok: true, order }
        : { ok: false, code: 403 };
}

module.exports = { branchLocationIds, orderScopeIds, applyOrderScope, orderInScope };
