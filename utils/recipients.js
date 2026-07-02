const { supabaseAdmin } = require('./supabase');

function validEmails(list) {
    return [...new Set(list.map(e => String(e || '').trim().toLowerCase())
        .filter(e => e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))];
}

/**
 * Resolve who should be emailed for an order:
 * the company notification/contact email + the company managers + the
 * servicing CHC branch assigned to the order's location. Deduped + validated.
 * @param {{company_id:string, location_id?:string}} order
 */
async function resolveOrderRecipients(order) {
    const { data: company } = await supabaseAdmin
        .from('companies').select('email_config, contact_email').eq('id', order.company_id).single();
    const cfg = company?.email_config || {};
    const base = cfg.notification_email || company?.contact_email;
    const managers = Array.isArray(cfg.manager_emails) ? cfg.manager_emails : [];

    let branchEmails = [];
    if (order.location_id) {
        const { data: loc } = await supabaseAdmin
            .from('company_locations').select('supplier_branch_id').eq('id', order.location_id).single();
        if (loc && loc.supplier_branch_id) {
            const { data: branch } = await supabaseAdmin
                .from('supplier_branches').select('emails, is_active').eq('id', loc.supplier_branch_id).single();
            if (branch && branch.is_active !== false && Array.isArray(branch.emails)) branchEmails = branch.emails;
        }
    }
    return validEmails([...(base ? [base] : []), ...managers, ...branchEmails]);
}

module.exports = { resolveOrderRecipients, validEmails };
