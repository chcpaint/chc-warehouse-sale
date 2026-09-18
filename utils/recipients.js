const { supabaseAdmin } = require('./supabase');

function validEmails(list) {
    return [...new Set(list.map(e => String(e || '').trim().toLowerCase())
        .filter(e => e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))];
}

/**
 * Every active order_desk staff email assigned to a branch -- legacy
 * admin_users.branch_id UNION admin_user_branches (migration 041) -- so
 * assigning someone to a branch in the Users admin screen puts them on that
 * branch's order emails automatically, without touching supplier_branches.emails
 * (which stays exactly what it always was: a manually-curated list, for a
 * shared inbox or a person who isn't a console user at all). A disabled
 * account's email is dropped even if the assignment row is still there --
 * nobody should keep getting order mail after being deactivated.
 */
async function branchStaffEmails(branchId) {
    if (!branchId) return [];
    const { data: assigned } = await supabaseAdmin
        .from('admin_user_branches')
        .select('admin_user_id')
        .eq('branch_id', branchId);
    const assignedIds = (assigned || []).map(r => r.admin_user_id);

    // Legacy single-branch accounts (branch_id set, no admin_user_branches
    // row yet -- shouldn't happen after migration 041's backfill, but a
    // manual DB edit could still produce one) are still honoured here.
    const { data: legacy } = await supabaseAdmin
        .from('admin_users')
        .select('id')
        .eq('branch_id', branchId);
    const ids = [...new Set([...assignedIds, ...(legacy || []).map(r => r.id)])];
    if (!ids.length) return [];

    const { data: staff } = await supabaseAdmin
        .from('admin_users')
        .select('email, is_active')
        .in('id', ids);
    return (staff || []).filter(s => s.is_active).map(s => s.email);
}

/**
 * Resolve who should be emailed for an order and who replies go to.
 * TO: the person who placed the order (order.contact_email) + the company's
 *     contact email (if set) + the company's manager/general group (optional,
 *     per-company) + the servicing CHC branch assigned to the order's location.
 * REPLY-TO: the orderer (falls back to the company contact) so replies from the
 *     branch/CHC land with the person who placed the order.
 *
 * Also split into `staffTo` (the servicing CHC branch only) and `customerTo`
 * (everyone else -- the orderer, the company contact, managers, the
 * location's own notify list) so a caller that needs to send staff the full
 * price and the customer side a packing slip (see utils/pricing-visibility.js)
 * knows exactly who is on which side. `to` is unchanged and still the union
 * of both, for every existing caller that doesn't need the split.
 *
 * @param {{company_id:string, location_id?:string, contact_email?:string}} order
 * @returns {Promise<{to:string[], replyTo?:string, staffTo:string[], customerTo:string[]}>}
 */
async function resolveOrderRecipients(order) {
    const { data: company } = await supabaseAdmin
        .from('companies').select('email_config, contact_email').eq('id', order.company_id).single();
    const cfg = company?.email_config || {};
    const companyContact = company?.contact_email;
    const managers = Array.isArray(cfg.manager_emails) ? cfg.manager_emails : [];

    let branchEmails = [];
    let locationEmails = [];
    if (order.location_id) {
        const { data: loc } = await supabaseAdmin
            .from('company_locations').select('supplier_branch_id, notify_emails').eq('id', order.location_id).single();
        if (loc) {
            if (Array.isArray(loc.notify_emails)) locationEmails = loc.notify_emails;
            if (loc.supplier_branch_id) {
                const { data: branch } = await supabaseAdmin
                    .from('supplier_branches').select('emails, is_active').eq('id', loc.supplier_branch_id).single();
                if (branch && branch.is_active !== false) {
                    // Manually-curated branch list UNION whichever active staff are
                    // now assigned to this branch in the Users admin screen -- see
                    // branchStaffEmails above.
                    const staffEmails = await branchStaffEmails(loc.supplier_branch_id);
                    branchEmails = [...(Array.isArray(branch.emails) ? branch.emails : []), ...staffEmails];
                }
            }
        }
    }

    const orderer = order.contact_email;
    const customerTo = validEmails([
        ...(orderer ? [orderer] : []),
        ...(companyContact ? [companyContact] : []),
        ...managers,
        ...locationEmails
    ]);
    const staffTo = validEmails(branchEmails);
    const to = validEmails([...customerTo, ...staffTo]);
    const replyTo = validEmails([...(orderer ? [orderer] : []), ...(companyContact ? [companyContact] : [])])[0];
    return { to, replyTo, staffTo, customerTo };
}

module.exports = { resolveOrderRecipients, validEmails, branchStaffEmails };
