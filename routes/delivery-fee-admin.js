/**
 * routes/delivery-fee-admin.js
 *
 * Delivery fee configuration, mounted from routes/admin.js at
 *   /api/admin/companies/:companyId/delivery-fee
 *
 * One thing CHC can set per customer: whether the $10 fee on an order under
 * $300 applies to them at all. See utils/delivery-fee.js for the rule the
 * storefront actually charges by.
 *
 * Deliberately NOT gated with requireCompanyAccess, unlike routes/tax-admin.js
 * and routes/po-admin.js. That guard refuses order_desk accounts outright and
 * has no path for order_manager either (it has no company_id of its own to
 * match) — but two order_desk accounts (the branch managers) and every
 * order_manager account are exactly who this feature exists to let toggle
 * this switch from the Orders screen. canManageDeliveryFee() below is the
 * real gate; every other admin role is refused the write the same way
 * requireCompanyAccess would refuse them elsewhere.
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { deliveryFeeSettings, THRESHOLD, FEE } = require('../utils/delivery-fee');

const router = express.Router({ mergeParams: true });

/**
 * Who may flip this switch for an account: any super_admin, any
 * order_manager (already trusted with every branch's orders), or the
 * specific order_desk accounts flagged is_branch_manager. Every other
 * order_desk account — the majority of them — is refused, the same as any
 * other account-configuration change.
 */
function canManageDeliveryFee(admin) {
    return !!admin && (
        admin.role === 'super_admin' ||
        admin.role === 'order_manager' ||
        admin.is_branch_manager === true
    );
}

async function logAction(adminId, action, entityType, entityId, details, ip) {
    try {
        await supabaseAdmin.from('audit_log').insert({
            admin_id: adminId, action, entity_type: entityType,
            entity_id: entityId, details, ip_address: ip
        });
    } catch (err) {
        console.error('Audit log write failed:', err);
    }
}

/**
 * GET /
 *
 * Readable by anyone who can see the Orders screen — it's one boolean, not
 * sensitive, and the screen has to render it either way (read-only) for
 * whoever cannot change it. `can_manage` tells the console whether to render
 * a live toggle or a plain badge for the admin looking at it.
 */
router.get('/', async (req, res) => {
    try {
        const companyId = req.params.companyId;
        const { data: company } = await supabaseAdmin
            .from('companies').select('id, name, settings').eq('id', companyId).maybeSingle();
        if (!company) return res.status(404).json({ error: 'Company not found.' });

        const settings = deliveryFeeSettings(company.settings);
        res.json({
            company: { id: company.id, name: company.name },
            enabled: settings.enabled,
            threshold: THRESHOLD,
            fee: FEE,
            can_manage: canManageDeliveryFee(req.admin)
        });
    } catch (err) {
        console.error('Delivery fee config read error:', err);
        res.status(500).json({ error: 'Failed to load delivery fee settings.' });
    }
});

/**
 * PUT /    Body: { enabled }
 */
router.put('/', async (req, res) => {
    try {
        if (!canManageDeliveryFee(req.admin)) {
            return res.status(403).json({ error: 'Only a branch manager or admin can change the delivery fee for an account.' });
        }
        if (typeof req.body?.enabled !== 'boolean') {
            return res.status(400).json({ error: '"enabled" must be true or false.' });
        }

        const companyId = req.params.companyId;
        const { data: company } = await supabaseAdmin
            .from('companies').select('id, name, settings').eq('id', companyId).maybeSingle();
        if (!company) return res.status(404).json({ error: 'Company not found.' });

        const enabled = req.body.enabled;
        const settings = {
            ...(company.settings || {}),
            delivery_fee: { enabled }
        };

        const { error } = await supabaseAdmin
            .from('companies')
            .update({ settings, updated_at: new Date().toISOString() })
            .eq('id', companyId);
        if (error) throw error;

        await logAction(req.admin.id, 'delivery_fee_toggled', 'company', companyId, { enabled }, req.ip);

        res.json({
            message: enabled
                ? `${company.name} will be charged a $${FEE.toFixed(2)} delivery fee on orders under $${THRESHOLD.toFixed(2)}.`
                : `${company.name} will not be charged a delivery fee, regardless of order size.`,
            enabled
        });
    } catch (err) {
        console.error('Delivery fee config write error:', err);
        res.status(500).json({ error: 'Failed to save delivery fee settings.' });
    }
});

module.exports = router;
module.exports.canManageDeliveryFee = canManageDeliveryFee;
