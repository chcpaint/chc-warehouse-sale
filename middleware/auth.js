const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../utils/supabase');

/**
 * Verify company session token (for storefront users)
 */
function requireCompanyAuth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
        return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.type !== 'company') {
            return res.status(403).json({ error: 'Invalid token type.' });
        }
        req.company = {
            id: decoded.company_id,
            slug: decoded.slug,
            name: decoded.company_name
        };
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token.' });
    }
}

/**
 * Verify admin JWT token
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

        // Fetch admin details to confirm they still exist and are active
        const { data: admin, error } = await supabaseAdmin
            .from('admin_users')
            .select('id, email, name, role, company_id, is_active')
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

/**
 * Require super_admin role
 */
function requireSuperAdmin(req, res, next) {
    if (!req.admin || req.admin.role !== 'super_admin') {
        return res.status(403).json({ error: 'Super admin access required.' });
    }
    next();
}

/**
 * Check admin has access to a specific company
 */
function requireCompanyAccess(req, res, next) {
    if (!req.admin) {
        return res.status(403).json({ error: 'Admin authentication required.' });
    }
    // Super admins can access any company
    if (req.admin.role === 'super_admin') return next();
    // Company admins can only access their own company
    const companyId = req.params.companyId || req.body.company_id;
    if (req.admin.company_id !== companyId) {
        return res.status(403).json({ error: 'Access denied for this company.' });
    }
    next();
}

module.exports = {
    requireCompanyAuth,
    requireAdminAuth,
    requireSuperAdmin,
    requireCompanyAccess
};
