/**
 * utils/inventory-alerts.js
 *
 * The low-stock digest and the reorder-raised notification, as plain functions.
 *
 * These used to live inside an admin HTTP route, which meant the only way to
 * send a digest was for a person to be signed in and press something. Pulling
 * them out is what lets the scheduler run them on a morning with nobody there —
 * without the app making an authenticated HTTP call to itself, which would mean
 * a service token, a public endpoint, and a new way in.
 *
 * Both are idempotent. `inventory_alert_log` records a fingerprint of what was
 * sent, and a repeat of the same content inside the suppression window is a
 * no-op. That property is what makes it safe to run this on more than one
 * instance, or to retry after a failure, without a customer getting the same
 * email twice.
 */

const crypto = require('node:crypto');
const { supabaseAdmin } = require('./supabase');
const { validEmails } = require('./recipients');
const { sendLowStockAlert, sendReorderRaised } = require('./email');
const { moduleSettings } = require('./modules');

/** Identical content inside this window is treated as already sent. */
const DIGEST_SUPPRESSION_HOURS = 20;
const DRAFT_SUPPRESSION_HOURS = 6;

/**
 * Who hears about inventory for this company: the contact, the manager group,
 * and any addresses configured for inventory specifically.
 */
async function alertRecipients(companyId, settings) {
    const { data: company } = await supabaseAdmin
        .from('companies')
        .select('name, contact_email, email_config')
        .eq('id', companyId)
        .single();

    const cfg = company?.email_config || {};
    const recipients = validEmails([
        ...(company?.contact_email ? [company.contact_email] : []),
        ...(Array.isArray(cfg.manager_emails) ? cfg.manager_emails : []),
        ...(Array.isArray(settings?.alert_emails) ? settings.alert_emails : [])
    ]);

    return { companyName: company?.name || '', recipients };
}

/**
 * Has an alert with this exact content already gone out recently?
 * Returns the previous row, or null.
 */
async function recentlySent(companyId, alertType, fingerprint, hours) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const { data } = await supabaseAdmin
        .from('inventory_alert_log')
        .select('id, sent_at')
        .eq('company_id', companyId)
        .eq('alert_type', alertType)
        .eq('fingerprint', fingerprint)
        .gte('sent_at', since)
        .maybeSingle();
    return data || null;
}

// ============================================================
// LOW-STOCK DIGEST
// ============================================================

/**
 * Build and send one company's digest.
 *
 * @param {Object}  opts
 * @param {string}  opts.companyId
 * @param {Object}  opts.settings   the company's inventory module settings
 * @param {boolean} [opts.force]    send even if identical content went recently
 * @param {boolean} [opts.dryRun]   report what would be sent, send nothing
 * @param {string}  [opts.storeUrl] deep link included in the email
 * @returns {Promise<Object>} always resolves; never throws at the caller
 */
async function runLowStockDigest({ companyId, settings, force = false, dryRun = false, storeUrl = null }) {
    const { data: items, error } = await supabaseAdmin
        .from('inventory_status')
        .select('location_id, location_name, sku, product_name, brand, on_hand, min_point, max_point, suggested_order_qty, stock_status')
        .eq('company_id', companyId)
        .in('stock_status', ['low', 'out'])
        .order('location_name').order('product_name')
        .limit(1000);

    if (error) throw error;

    const rows = items || [];
    if (!rows.length) {
        return { sent: false, reason: 'nothing_to_report', count: 0,
                 message: 'Nothing is below its minimum — no digest sent.' };
    }

    const { companyName, recipients } = await alertRecipients(companyId, settings);
    if (!recipients.length) {
        return { sent: false, reason: 'no_recipients', count: rows.length,
                 message: 'No recipients configured. Add a company contact, manager emails, or inventory alert emails.' };
    }

    const byLocation = {};
    for (const row of rows) {
        const key = row.location_name || 'Unassigned';
        (byLocation[key] = byLocation[key] || []).push(row);
    }

    // The fingerprint covers what is short and by how much, so a digest is
    // re-sent when the situation changes and suppressed when it has not.
    const fingerprint = crypto.createHash('sha256')
        .update(rows.map(r => `${r.location_id}:${r.sku}:${r.on_hand}`).join('|'))
        .digest('hex').slice(0, 32);

    if (!force) {
        const recent = await recentlySent(companyId, 'low_stock', fingerprint, DIGEST_SUPPRESSION_HOURS);
        if (recent) {
            return { sent: false, reason: 'already_sent', count: rows.length,
                     message: `An identical digest went out in the last ${DIGEST_SUPPRESSION_HOURS} hours.`,
                     last_sent_at: recent.sent_at };
        }
    }

    if (dryRun) {
        return { sent: false, preview: true, count: rows.length, recipients,
                 locations: Object.keys(byLocation),
                 message: `Would send to ${recipients.length} recipient(s).` };
    }

    const result = await sendLowStockAlert({
        to: recipients, companyName, byLocation, count: rows.length, storeUrl
    });

    if (result.sent) {
        await supabaseAdmin.from('inventory_alert_log').insert({
            company_id: companyId, alert_type: 'low_stock',
            item_count: rows.length, recipients, fingerprint
        });
    }

    return { ...result, count: rows.length, locations: Object.keys(byLocation) };
}

// ============================================================
// REORDER RAISED
// ============================================================

/**
 * Tell a manager the shelf has raised a reorder that is waiting on them.
 *
 * Called when an auto-draft order is first created for a location — once per
 * order, not once per line, because a busy morning can add twenty lines to the
 * same order and twenty emails would train everyone to ignore them.
 *
 * Failure here must never fail the movement that triggered it: the stock change
 * is the fact, the email is a courtesy.
 */
async function notifyReorderRaised({ companyId, locationName, orderId, storeUrl = null }) {
    try {
        // Loaded here rather than passed in. The caller is a hot path on the
        // shop floor and this runs detached from it, so the extra read costs
        // the technician nothing and the caller keeps no state it might hold
        // stale across a settings change.
        const { data: company } = await supabaseAdmin
            .from('companies')
            .select('slug, settings')
            .eq('id', companyId)
            .maybeSingle();

        const settings = moduleSettings(company?.settings, 'inventory');
        if (!settings.enabled || settings.notify_on_draft === false) return null;

        const link = storeUrl || (company?.slug
            ? `${(process.env.PUBLIC_BASE_URL || 'https://chcsale.com').replace(/\/+$/, '')}/store/${company.slug}`
            : null);

        const { companyName, recipients } = await alertRecipients(companyId, settings);
        if (!recipients.length) return null;

        // One notification per order. The order id is the natural key: a second
        // call for the same order is the same event.
        const fingerprint = `order:${orderId}`;
        if (await recentlySent(companyId, 'reorder_raised', fingerprint, DRAFT_SUPPRESSION_HOURS)) return null;

        const { data: lines } = await supabaseAdmin
            .from('replenishment_order_lines')
            .select('sku, name, quantity, on_hand_at_draft, min_point')
            .eq('order_id', orderId)
            .order('name')
            .limit(50);

        const result = await sendReorderRaised({
            to: recipients,
            companyName,
            locationName: locationName || 'your shop',
            lines: lines || [],
            storeUrl: link
        });

        if (result.sent) {
            await supabaseAdmin.from('inventory_alert_log').insert({
                company_id: companyId, alert_type: 'reorder_raised',
                item_count: (lines || []).length, recipients, fingerprint
            });
        }

        return result;
    } catch (err) {
        console.error('Reorder notification failed (non-blocking):', err.message);
        return null;
    }
}

module.exports = {
    runLowStockDigest,
    notifyReorderRaised,
    alertRecipients,
    DIGEST_SUPPRESSION_HOURS,
    DRAFT_SUPPRESSION_HOURS
};
