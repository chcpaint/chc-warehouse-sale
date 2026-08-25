const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../utils/supabase');
const { orderInScope } = require('../utils/order-scope');

/**
 * Verify a storefront session token.
 *
 * Accepts BOTH kinds of storefront token so the two login modes coexist:
 *   - type 'company'      : the shared company access-code session (default).
 *   - type 'company_user' : an individual customer user (when the company has
 *                           the Customer-users module on). req.companyUser is
 *                           set so an order can be attributed to the person.
 */
function requireCompanyAuth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
        return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        if (decoded.type === 'company') {
            req.company = { id: decoded.company_id, slug: decoded.slug, name: decoded.company_name };
            req.companyUser = null;
            return next();
        }

        if (decoded.type === 'company_user') {
            req.company = { id: decoded.company_id, slug: decoded.slug, name: decoded.company_name };
            req.companyUser = {
                id: decoded.user_id,
                name: decoded.user_name,
                email: decoded.user_email,
                role: decoded.user_role,
                location_id: decoded.location_id || null
            };
            return next();
        }

        return res.status(403).json({ error: 'Invalid token type.' });
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token.' });
    }
}

/** Require an individual customer user (not the shared company session). */
function requireCompanyUser(req, res, next) {
    if (!req.companyUser) {
        return res.status(403).json({ error: 'Please sign in with your own account.' });
    }
    next();
}

/** Require the company owner role (manages their company's users). */
function requireCompanyOwner(req, res, next) {
    if (!req.companyUser || req.companyUser.role !== 'owner') {
        return res.status(403).json({ error: 'Owner access required.' });
    }
    next();
}

/**
 * Verify admin JWT token.
 */
async function requireAdminAuth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
        return res.status(401).json({ error: 'Admin access denied. No token provided.' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.type !== 'admin') {
            return res.status(403).json({ error: 'Invalid token type.' });
        }

        // Reload the admin so a disabled account or a role/branch change takes
        // effect immediately, not only at next login.
        const { data: admin, error } = await supabaseAdmin
            .from('admin_users')
            .select('id, email, name, role, company_id, branch_id, is_active')
            .eq('id', decoded.admin_id)
            .single();

        if (error || !admin || !admin.is_active) {
            return res.status(401).json({ error: 'Admin account not found or disabled.' });
        }

        req.admin = admin;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired admin token.' });
    }
}

/** Require super_admin role. */
function requireSuperAdmin(req, res, next) {
    if (!req.admin || req.admin.role !== 'super_admin') {
        return res.status(403).json({ error: 'Super admin access required.' });
    }
    next();
}

/**
 * Full-console roles (everything except order-desk). Use to fence off any
 * endpoint that changes account configuration from an order-desk user.
 */
function requireFullAdmin(req, res, next) {
    if (!req.admin || !['super_admin', 'admin'].includes(req.admin.role)) {
        return res.status(403).json({ error: 'This area is not available to order-desk accounts.' });
    }
    next();
}

/**
 * Check admin has access to a specific company (via :companyId / body).
 * Super admins pass; company admins must match; order-desk is handled by the
 * order-scoped guard instead and is refused here.
 */
function requireCompanyAccess(req, res, next) {
    if (!req.admin) {
        return res.status(403).json({ error: 'Admin authentication required.' });
    }
    if (req.admin.role === 'super_admin') return next();
    if (req.admin.role === 'order_desk') {
        return res.status(403).json({ error: 'This area is not available to order-desk accounts.' });
    }
    const companyId = req.params.companyId || req.body.company_id;
    if (req.admin.company_id !== companyId) {
        return res.status(403).json({ error: 'Access denied for this company.' });
    }
    next();
}

/**
 * The ONLY endpoints an order-desk account may reach. Anything outside this
 * allow-list is refused, so isolation does not depend on the UI hiding buttons —
 * a desk user who calls another endpoint directly is still stopped. Full admins
 * pass straight through.
 *
 * Paths are relative to the /api/admin mount.
 */
const ORDER_DESK_ALLOW = [
    ['GET', /^\/orders$/],
    ['GET', /^\/orders\/export$/],
    ['GET', /^\/reports\/orders$/],
    ['GET', /^\/reports\/by-location$/],
    ['PUT', /^\/orders\/[^/]+\/status$/],
    ['POST', /^\/companies\/[^/]+\/orders\/[^/]+\/invoice$/],
    ['GET', /^\/companies\/[^/]+\/orders\/[^/]+\/invoice$/],
    ['PUT', /^\/companies\/[^/]+\/orders\/[^/]+\/close$/],
    ['GET', /^\/whoami$/]
];

function restrictOrderDesk(req, res, next) {
    if (!req.admin || req.admin.role !== 'order_desk') return next();
    const allowed = ORDER_DESK_ALLOW.some(([m, re]) => m === req.method && re.test(req.path));
    if (!allowed) {
        return res.status(403).json({ error: 'Your account has access to order management only.' });
    }
    next();
}

/**
 * Guard a single-order workflow action (invoice upload/view, close, status) so
 * it works for super admins, the owning company admin, AND an order-desk user
 * whose branch the order belongs to — but no one else.
 */
async function requireOrderAccess(req, res, next) {
    if (!req.admin) return res.status(403).json({ error: 'Admin authentication required.' });
    if (req.admin.role === 'super_admin') return next();

    if (req.admin.role === 'order_desk') {
        const chk = await orderInScope(req, req.params.orderId);
        if (!chk.ok) return res.status(chk.code).json({ error: 'Access denied for this order.' });
        return next();
    }

    // Company-scoped admin.
    if (req.admin.company_id !== req.params.companyId) {
        return res.status(403).json({ error: 'Access denied for this company.' });
    }
    next();
}

module.exports = {
    requireCompanyAuth,
    requireCompanyUser,
    requireCompanyOwner,
    requireAdminAuth,
    requireSuperAdmin,
    requireFullAdmin,
    requireCompanyAccess,
    restrictOrderDesk,
    requireOrderAccess
};
