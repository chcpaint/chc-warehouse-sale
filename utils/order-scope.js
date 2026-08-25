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
 * Apply role scoping to a Supabase orders query builder.
 * `companyId` is an optional super-admin filter (from the query string).
 */
async function scopeOrders(query, req, { companyId } = {}) {
    const role = req.admin.role;

    if (role === 'super_admin') {
        if (companyId) query = query.eq('company_id', companyId);
        return query;
    }

    if (role === 'order_desk') {
        const ids = await branchLocationIds(req.admin.branch_id);
        return query.in('location_id', ids.length ? ids : [NO_MATCH]);
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

module.exports = { branchLocationIds, scopeOrders, orderInScope };
