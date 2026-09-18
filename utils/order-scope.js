/**
 * utils/order-scope.js
 *
 * One place that decides which orders an admin may see or touch, so every order
 * endpoint scopes the same way and a branch's order desk can never reach another
 * branch's orders.
 *
 * Four kinds of admin:
 *   - super_admin      : every order.
 *   - company admin    : orders for their own company_id (existing behaviour).
 *   - order_desk       : orders whose delivery location belongs to one of the
 *                        CHC branches this account is assigned to (see
 *                        staffBranchIds), optionally narrowed to specific
 *                        customers (see staffCompanyIds). Migration 020 gave
 *                        every order_desk account exactly one branch via
 *                        admin_users.branch_id; migration 041 added
 *                        admin_user_branches/admin_user_companies so an
 *                        account can be assigned to several branches and,
 *                        optionally, restricted to specific customers within
 *                        them. Every helper below unions the legacy column
 *                        with the new tables, so an account nobody has
 *                        touched since migration 041 keeps working exactly
 *                        as before.
 *   - order_manager    : every order, every branch. Head office. Reaches the
 *                        same order-only endpoints as a desk, never the rest of
 *                        the console — see ORDER_DESK_ALLOW. Deliberately has
 *                        no assignment rows of its own: the role already means
 *                        "everything", so a picker would only imply a limit
 *                        that isn't real.
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
 * Every CHC branch id this account is assigned to: its legacy admin_users.branch_id
 * (if set) UNION its rows in admin_user_branches (migration 041). Takes an admin-shaped
 * object ({ id, branch_id, ... }) rather than req, so it works equally for "my own
 * access" (req.admin) and "this other account's access" (a row from admin_users, e.g.
 * from routes/admin-users.js managing someone else).
 */
async function staffBranchIds(admin) {
    const ids = new Set();
    if (admin.branch_id) ids.add(admin.branch_id);
    const { data } = await supabaseAdmin
        .from('admin_user_branches')
        .select('branch_id')
        .eq('admin_user_id', admin.id);
    (data || []).forEach(r => ids.add(r.branch_id));
    return [...ids];
}

/**
 * The OPTIONAL customer narrowing for this account (admin_user_companies).
 * Empty means "no narrowing" -- every customer the assigned branches serve,
 * which is the behaviour every order_desk account had before this table
 * existed. A non-empty list restricts to just these customers even within a
 * branch that serves more.
 */
async function staffCompanyIds(admin) {
    const { data } = await supabaseAdmin
        .from('admin_user_companies')
        .select('company_id')
        .eq('admin_user_id', admin.id);
    return [...new Set((data || []).map(r => r.company_id))];
}

/**
 * The full set of company_location ids this account may see: every location
 * routed to one of its branches, narrowed to its assigned customers if any
 * are set. This is what order_desk visibility actually resolves to; the two
 * helpers above are the building blocks, this is the one most callers want.
 */
async function staffLocationIds(admin) {
    const branchIds = await staffBranchIds(admin);
    if (!branchIds.length) return [];

    const { data } = await supabaseAdmin
        .from('company_locations')
        .select('id, company_id')
        .in('supplier_branch_id', branchIds);
    let locations = data || [];

    const companyIds = await staffCompanyIds(admin);
    if (companyIds.length) {
        const allowed = new Set(companyIds);
        locations = locations.filter(l => allowed.has(l.company_id));
    }
    return locations.map(l => l.id);
}

/**
 * Resolve any async data the scope needs BEFORE touching the query builder.
 * For an order desk that means its assigned branches'/customers' location
 * ids. Returns null for roles that need no pre-fetch.
 *
 * Kept separate from applyOrderScope on purpose: a PostgREST builder is a
 * thenable, so if an async function returned one, `await` would adopt it and
 * execute the query early — returning a result instead of a builder. Fetching
 * ids here (async) and applying the filter there (sync) avoids that trap.
 */
async function orderScopeIds(req) {
    if (req.admin.role === 'order_desk') {
        return staffLocationIds(req.admin);
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
        const ids = await staffLocationIds(req.admin);
        return ids.includes(order.location_id)
            ? { ok: true, order }
            : { ok: false, code: 403 };
    }

    return order.company_id === req.admin.company_id
        ? { ok: true, order }
        : { ok: false, code: 403 };
}

/**
 * Is a COMPANY (not a single order) within this admin's scope? Used to guard
 * company-wide staff actions that aren't about any one order -- right now
 * that's just company_notes (see requireCompanyNotesAccess in
 * middleware/auth.js). Mirrors orderInScope's role logic one level up: an
 * order_desk account's assigned branches have to actually serve at least one
 * of the company's locations (and, if it has a customer narrowing, the
 * company has to be in it), not just any location anywhere.
 */
async function companyInScope(req, companyId) {
    const role = req.admin.role;
    if (role === 'super_admin' || role === 'order_manager') return true;

    if (role === 'order_desk') {
        const ids = await staffLocationIds(req.admin);
        if (!ids.length) return false;
        const { data } = await supabaseAdmin
            .from('company_locations')
            .select('id')
            .eq('company_id', companyId)
            .in('id', ids)
            .limit(1);
        return Boolean(data && data.length);
    }

    return req.admin.company_id === companyId;
}

module.exports = {
    branchLocationIds, staffBranchIds, staffCompanyIds, staffLocationIds,
    orderScopeIds, applyOrderScope, orderInScope, companyInScope
};
