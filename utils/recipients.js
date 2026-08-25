const { supabaseAdmin } = require('./supabase');

function validEmails(list) {
    return [...new Set(list.map(e => String(e || '').trim().toLowerCase())
        .filter(e => e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))];
}

/**
 * Resolve who should be emailed for an order and who replies go to.
 * TO: the person who placed the order (order.contact_email) + the company's
 *     contact email (if set) + the company's manager/general group (optional,
 *     per-company) + the servicing CHC branch assigned to the order's location.
 * REPLY-TO: the orderer (falls back to the company contact) so replies from the
 *     branch/CHC land with the person who placed the order.
 * @param {{company_id:string, location_id?:string, contact_email?:string}} order
 * @returns {Promise<{to:string[], replyTo?:string}>}
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
                if (branch && branch.is_active !== false && Array.isArray(branch.emails)) branchEmails = branch.emails;
            }
        }
    }

    const orderer = order.contact_email;
    const to = validEmails([
        ...(orderer ? [orderer] : []),
        ...(companyContact ? [companyContact] : []),
        ...managers,
        ...locationEmails,
        ...branchEmails
    ]);
    const replyTo = validEmails([...(orderer ? [orderer] : []), ...(companyContact ? [companyContact] : [])])[0];
    return { to, replyTo };
}

module.exports = { resolveOrderRecipients, validEmails };
