const sgMail = require('@sendgrid/mail');

/**
 * Initialize SendGrid with API key.
 * Uses SENDGRID_API_KEY env var, or falls back to SMTP_PASS (which is the API key for SendGrid SMTP).
 */
function initSendGrid() {
    const apiKey = process.env.SENDGRID_API_KEY || process.env.SMTP_PASS;
    if (!apiKey) {
        console.warn('Email: No SendGrid API key. Set SENDGRID_API_KEY or SMTP_PASS.');
        return false;
    }
    sgMail.setApiKey(apiKey);
    return true;
}

let initialized = false;

function ensureInit() {
    if (!initialized) {
        initialized = initSendGrid();
    }
    return initialized;
}

/**
 * Send an order notification email via SendGrid Web API.
 * @param {Object} options
 * @param {string} options.to - Recipient email address
 * @param {Object} options.order - Order object (id, order_number, total, items, etc.)
 * @param {string} options.companyName - Company name
 * @param {string} options.contactName - Person who placed the order
 * @param {string} options.contactEmail - Their email
 * @param {string} options.contactPhone - Their phone (optional)
 * @param {string} options.location - Delivery location (optional)
 * @param {string} options.notes - Order notes (optional)
 */
async function sendOrderNotification(options) {
    if (!ensureInit()) {
        console.warn('Email: Skipping order notification — SendGrid not configured.');
        return { sent: false, reason: 'not_configured' };
    }

    const { to, order, companyName, contactName, contactEmail, contactPhone, poNumber, location, notes, replyTo } = options;

    // `to` may be a single address or an array of manager addresses
    const recipients = (Array.isArray(to) ? to : [to]).map(x => String(x || '').trim()).filter(Boolean);
    if (!recipients.length) {
        console.warn('Email: No notification email configured for this company.');
        return { sent: false, reason: 'no_recipient' };
    }

    const fromAddress = process.env.SMTP_FROM || process.env.EMAIL_FROM || 'promo@chcpaint.com';

    // Items the branch has to price at pick. Counted from the line items rather
    // than trusting a field on the order, so the email can never disagree with
    // the list printed beneath it.
    const quotedCount = (order.items || []).filter(i => i.price_on_request).length;

    // Build line items HTML
    const itemsHtml = (order.items || []).map(item => `
        <tr>
            <td style="padding: 8px; border-bottom: 1px solid #eee;">${escHtml(item.name)}</td>
            <td style="padding: 8px; border-bottom: 1px solid #eee;">${escHtml(item.sku || '-')}</td>
            <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: center;">${item.quantity}</td>
            <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right;">${item.price_on_request
                ? '<span style="color:#1d4ed8;font-weight:600;">Price on request</span>'
                : '$' + Number(item.unit_price).toFixed(2)}</td>
            <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right;">${item.price_on_request
                ? '<span style="color:#1d4ed8;font-weight:600;">TO PRICE</span>'
                : '$' + Number(item.subtotal).toFixed(2)}</td>
        </tr>
    `).join('');

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1e40af; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
            <h2 style="margin: 0;">Order Received</h2>
            <p style="margin: 5px 0 0; opacity: 0.9;">Order #${escHtml(order.order_number || order.id)}</p>
        </div>
        <div style="padding: 20px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
            <h3 style="color: #374151; margin-top: 0;">Company: ${escHtml(companyName)}</h3>
            <p style="color:#374151; margin:0 0 15px;">Thank you — we've received your order. Our team will follow up with your invoice for payment. A copy is below for your records.</p>

            ${poNumber ? `<div style="margin-bottom: 15px; padding: 12px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 6px;">
                <strong style="font-size: 16px; color: #1e40af;">PO #: ${escHtml(poNumber)}</strong>
            </div>` : ''}

            ${quotedCount ? `<div style="margin-bottom: 15px; padding: 12px; background: #fffbeb; border: 1px solid #fcd34d; border-radius: 6px;">
                <strong style="font-size: 15px; color: #92400e;">${quotedCount} item${quotedCount === 1 ? '' : 's'} on this order need${quotedCount === 1 ? 's' : ''} pricing</strong>
                <p style="margin: 6px 0 0; color: #92400e; font-size: 13px;">
                    Marked <strong>TO PRICE</strong> below. The total shown excludes them — add the price at pick,
                    once you have a true cost.
                </p>
            </div>` : ''}

            <table style="width: 100%; margin-bottom: 15px;">
                <tr><td style="padding: 4px 0; color: #6b7280;">Ordered by:</td><td style="padding: 4px 0;">${escHtml(contactName)}</td></tr>
                <tr><td style="padding: 4px 0; color: #6b7280;">Email:</td><td style="padding: 4px 0;">${escHtml(contactEmail)}</td></tr>
                ${contactPhone ? `<tr><td style="padding: 4px 0; color: #6b7280;">Phone:</td><td style="padding: 4px 0;">${escHtml(contactPhone)}</td></tr>` : ''}
                ${location ? `<tr><td style="padding: 4px 0; color: #6b7280;">Location:</td><td style="padding: 4px 0;">${escHtml(location)}</td></tr>` : ''}
            </table>

            <h4 style="color: #374151; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px;">Order Items</h4>
            <table style="width: 100%; border-collapse: collapse;">
                <thead>
                    <tr style="background: #f9fafb;">
                        <th style="padding: 8px; text-align: left; font-size: 12px; color: #6b7280;">Product</th>
                        <th style="padding: 8px; text-align: left; font-size: 12px; color: #6b7280;">SKU</th>
                        <th style="padding: 8px; text-align: center; font-size: 12px; color: #6b7280;">Qty</th>
                        <th style="padding: 8px; text-align: right; font-size: 12px; color: #6b7280;">Price</th>
                        <th style="padding: 8px; text-align: right; font-size: 12px; color: #6b7280;">Subtotal</th>
                    </tr>
                </thead>
                <tbody>${itemsHtml}</tbody>
                <tfoot>
                    <tr>
                        <td colspan="4" style="padding: 6px 8px; text-align: right; color: #6b7280;">Subtotal:</td>
                        <td style="padding: 6px 8px; text-align: right; color: #6b7280;">$${Number(order.subtotal).toFixed(2)}</td>
                    </tr>
                    ${order.tax ? `<tr>
                        <td colspan="4" style="padding: 6px 8px; text-align: right; color: #6b7280;">Tax${order.tax_rate ? ` (${(Number(order.tax_rate) * 100).toFixed(0)}%)` : ''}:</td>
                        <td style="padding: 6px 8px; text-align: right; color: #6b7280;">$${Number(order.tax).toFixed(2)}</td>
                    </tr>` : ''}
                    <tr>
                        <td colspan="4" style="padding: 10px 8px; text-align: right; font-weight: bold;">Total:</td>
                        <td style="padding: 10px 8px; text-align: right; font-weight: bold; font-size: 16px; color: #1e40af;">$${Number(order.total).toFixed(2)}</td>
                    </tr>
                </tfoot>
            </table>

            ${notes ? `<div style="margin-top: 15px; padding: 12px; background: #f9fafb; border-radius: 6px;"><strong>Notes:</strong> ${escHtml(notes)}</div>` : ''}

            <p style="margin-top: 20px; color: #9ca3af; font-size: 12px;">This is an automated notification from CHC Paint & Auto Body Supplies ordering platform.</p>
        </div>
    </div>`;

    const textItems = (order.items || []).map(i => i.price_on_request
        ? `  - ${i.name} (${i.sku || 'N/A'}) x${i.quantity} = ** TO PRICE **`
        : `  - ${i.name} (${i.sku || 'N/A'}) x${i.quantity} = $${Number(i.subtotal).toFixed(2)}`).join('\n');
    const totalsText = `Subtotal: $${Number(order.subtotal).toFixed(2)}${order.tax ? `\nTax${order.tax_rate ? ` (${(Number(order.tax_rate) * 100).toFixed(0)}%)` : ''}: $${Number(order.tax).toFixed(2)}` : ''}\nTotal: $${Number(order.total).toFixed(2)}`;
    const text = `New Order #${order.order_number || order.id}${quotedCount ? `\n\n*** ${quotedCount} ITEM(S) NEED PRICING — see "TO PRICE" below. The total excludes them. ***` : ''}\nCompany: ${companyName}${poNumber ? `\nPO #: ${poNumber}` : ''}\nOrdered by: ${contactName} (${contactEmail})${location ? `\nLocation: ${location}` : ''}\n\nItems:\n${textItems}\n\n${totalsText}${notes ? `\n\nNotes: ${notes}` : ''}`;

    try {
        await sgMail.send({
            to: recipients,
            from: fromAddress,
            subject: `Order received \u2014 ${companyName} order ${order.order_number || order.id}${location ? ', ' + location : ''}`,
            replyTo: replyTo || undefined,
            text,
            html
        });
        console.log(`Email: Order notification sent to ${recipients.join(', ')} for order ${order.order_number || order.id}`);
        return { sent: true };
    } catch (err) {
        const errMsg = err.response?.body?.errors?.[0]?.message || err.message;
        console.error('Email: Failed to send order notification:', errMsg);
        return { sent: false, reason: 'send_failed', error: errMsg };
    }
}

/**
 * Notify recipients that an invoice is ready to retrieve for an order.
 */
async function sendInvoiceReady(options) {
    if (!ensureInit()) return { sent: false, reason: 'not_configured' };
    const { to, order, companyName, retrieveUrl, replyTo } = options;
    const recipients = (Array.isArray(to) ? to : [to]).map(x => String(x || '').trim()).filter(Boolean);
    if (!recipients.length) return { sent: false, reason: 'no_recipient' };
    const fromAddress = process.env.SMTP_FROM || process.env.EMAIL_FROM || 'promo@chcpaint.com';
    const orderNo = order.order_number || order.id;
    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1e40af; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
            <h2 style="margin: 0;">Invoice Ready</h2>
            <p style="margin: 5px 0 0; opacity: 0.9;">Order #${escHtml(orderNo)}</p>
        </div>
        <div style="padding: 20px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
            <p>An invoice is now available for <strong>${escHtml(companyName)}</strong> order <strong>#${escHtml(orderNo)}</strong>.</p>
            <p>Sign in to your store, open the order in your order history, and download the invoice to print and make payment.</p>
            ${retrieveUrl ? `<p style="margin-top:20px;"><a href="${escHtml(retrieveUrl)}" style="background:#1e40af;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;">Go to your store</a></p>` : ''}
            <p style="margin-top: 20px; color: #9ca3af; font-size: 12px;">Automated notification from CHC Paint & Auto Body Supplies ordering platform.</p>
        </div>
    </div>`;
    const text = `Invoice ready for ${companyName} order #${orderNo}.\nSign in to your store and open the order to download the invoice.${retrieveUrl ? '\n' + retrieveUrl : ''}`;
    try {
        await sgMail.send({ to: recipients, from: fromAddress, subject: `Invoice ready — ${companyName} order ${orderNo}`, text, html });
        console.log(`Email: Invoice-ready sent to ${recipients.join(', ')} for order ${orderNo}`);
        return { sent: true };
    } catch (err) {
        const errMsg = err.response?.body?.errors?.[0]?.message || err.message;
        console.error('Email: Failed to send invoice-ready:', errMsg);
        return { sent: false, reason: 'send_failed', error: errMsg };
    }
}


/**
 * Notify recipients that payment was received and the order is closed (step 3 of 3).
 */
async function sendOrderClosed(options) {
    if (!ensureInit()) return { sent: false, reason: 'not_configured' };
    const { to, order, companyName, replyTo } = options;
    const recipients = (Array.isArray(to) ? to : [to]).map(x => String(x || '').trim()).filter(Boolean);
    if (!recipients.length) return { sent: false, reason: 'no_recipient' };
    const fromAddress = process.env.SMTP_FROM || process.env.EMAIL_FROM || 'promo@chcpaint.com';
    const orderNo = order.order_number || order.id;
    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #047857; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
            <h2 style="margin: 0;">Payment Received — Order Closed</h2>
            <p style="margin: 5px 0 0; opacity: 0.9;">Order #${escHtml(orderNo)}</p>
        </div>
        <div style="padding: 20px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
            <p>Payment has been received for <strong>${escHtml(companyName)}</strong> order <strong>#${escHtml(orderNo)}</strong> and the order is now closed.</p>
            <p>Thank you for your business.</p>
            <p style="margin-top: 20px; color: #9ca3af; font-size: 12px;">Automated notification from CHC Paint & Auto Body Supplies ordering platform.</p>
        </div>
    </div>`;
    const text = `Payment received for ${companyName} order #${orderNo}. The order is now closed. Thank you for your business.`;
    try {
        await sgMail.send({ to: recipients, from: fromAddress, subject: `Payment received — ${companyName} order ${orderNo}`, text, html });
        console.log(`Email: Order-closed sent to ${recipients.join(', ')} for order ${orderNo}`);
        return { sent: true };
    } catch (err) {
        const errMsg = err.response?.body?.errors?.[0]?.message || err.message;
        console.error('Email: Failed to send order-closed:', errMsg);
        return { sent: false, reason: 'send_failed', error: errMsg };
    }
}

/**
 * refinishAI Inventory — low-stock digest.
 *
 * One email per company covering every location, rather than one per shop: a
 * three-site group otherwise gets three emails every morning and starts
 * ignoring all of them.
 *
 * @param {Object} options
 * @param {string[]} options.to
 * @param {string} options.companyName
 * @param {Object} options.byLocation  { [locationName]: item[] }
 * @param {number} options.count       total low/out items
 * @param {string} [options.storeUrl]  deep link back into the console
 * @param {string} [options.replyTo]
 */
async function sendLowStockAlert(options) {
    if (!ensureInit()) return { sent: false, reason: 'not_configured' };

    const { to, companyName, byLocation, count, storeUrl, replyTo } = options;
    const recipients = (Array.isArray(to) ? to : [to]).map(x => String(x || '').trim()).filter(Boolean);
    if (!recipients.length) return { sent: false, reason: 'no_recipient' };
    if (!count) return { sent: false, reason: 'nothing_to_report' };

    const fromAddress = process.env.SMTP_FROM || process.env.EMAIL_FROM || 'promo@chcpaint.com';

    const sections = Object.entries(byLocation || {}).map(([location, items]) => {
        const rows = items.slice(0, 40).map(i => `
            <tr>
                <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;">
                    <strong>${escHtml(i.product_name)}</strong><br>
                    <span style="color:#6b7280;font-size:12px;">${escHtml(i.sku || '')}${i.brand ? ' &middot; ' + escHtml(i.brand) : ''}</span>
                </td>
                <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right;
                           color:${Number(i.on_hand) <= 0 ? '#b91c1c' : '#b45309'};font-weight:600;">
                    ${escHtml(String(i.on_hand))}
                </td>
                <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right;color:#6b7280;">
                    ${escHtml(String(i.min_point ?? '—'))}
                </td>
                <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right;">
                    ${escHtml(String(i.suggested_order_qty ?? ''))}
                </td>
            </tr>`).join('');

        const more = items.length > 40
            ? `<p style="color:#6b7280;font-size:12px;margin:6px 0 0;">…and ${items.length - 40} more at this location.</p>`
            : '';

        return `
        <h3 style="margin:22px 0 8px;font-size:15px;color:#111827;">${escHtml(location)}
            <span style="color:#6b7280;font-weight:400;font-size:13px;">— ${items.length} item${items.length === 1 ? '' : 's'}</span>
        </h3>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead>
                <tr style="text-align:left;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:.04em;">
                    <th style="padding:4px 8px;">Item</th>
                    <th style="padding:4px 8px;text-align:right;">On hand</th>
                    <th style="padding:4px 8px;text-align:right;">Min</th>
                    <th style="padding:4px 8px;text-align:right;">Suggested</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>${more}`;
    }).join('');

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto;">
        <div style="background:#1e40af;color:#fff;padding:20px;border-radius:8px 8px 0 0;">
            <h2 style="margin:0;">Low stock &mdash; ${escHtml(companyName)}</h2>
            <p style="margin:5px 0 0;opacity:.9;">${count} item${count === 1 ? '' : 's'} at or below the shelf minimum</p>
        </div>
        <div style="padding:20px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
            ${sections}
            ${storeUrl ? `<p style="margin-top:24px;">
                <a href="${escHtml(storeUrl)}" style="background:#1e40af;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;">
                    Review the reorder queue</a></p>` : ''}
            <p style="margin-top:24px;color:#9ca3af;font-size:12px;">
                Automated digest from refinishAI Inventory, part of the CHC Paint &amp; Auto Body Supplies ordering platform.
                Reorder suggestions are drafts only &mdash; nothing is ordered until someone approves it.
            </p>
        </div>
    </div>`;

    const textLines = [`Low stock for ${companyName} — ${count} item(s) at or below minimum.`, ''];
    for (const [location, items] of Object.entries(byLocation || {})) {
        textLines.push(`${location} (${items.length}):`);
        for (const i of items.slice(0, 40)) {
            textLines.push(`  - ${i.sku || ''} ${i.product_name}: ${i.on_hand} on hand (min ${i.min_point ?? '-'})`);
        }
        textLines.push('');
    }
    if (storeUrl) textLines.push(storeUrl);

    try {
        const msg = {
            to: recipients,
            from: fromAddress,
            subject: `Low stock — ${companyName} (${count} item${count === 1 ? '' : 's'})`,
            text: textLines.join('\n'),
            html
        };
        if (replyTo) msg.replyTo = replyTo;
        await sgMail.send(msg);
        console.log(`Email: Low-stock digest sent to ${recipients.join(', ')} (${count} items)`);
        return { sent: true, recipients, count };
    } catch (err) {
        const errMsg = err.response?.body?.errors?.[0]?.message || err.message;
        console.error('Email: Failed to send low-stock digest:', errMsg);
        return { sent: false, reason: 'send_failed', error: errMsg };
    }
}

/**
 * refinishAI Inventory — a reorder the shelf raised, waiting for approval.
 *
 * Sent once per order rather than once per line: a busy morning adds many lines
 * to the same open order, and an email for each would train the recipient to
 * ignore all of them.
 */
async function sendReorderRaised(options) {
    if (!ensureInit()) return { sent: false, reason: 'not_configured' };

    const { to, companyName, locationName, lines, storeUrl, replyTo } = options;
    const recipients = (Array.isArray(to) ? to : [to]).map(x => String(x || '').trim()).filter(Boolean);
    if (!recipients.length) return { sent: false, reason: 'no_recipient' };

    const items = Array.isArray(lines) ? lines : [];
    if (!items.length) return { sent: false, reason: 'nothing_to_report' };

    const fromAddress = process.env.SMTP_FROM || process.env.EMAIL_FROM || 'promo@chcpaint.com';

    const rows = items.slice(0, 40).map(l => `
        <tr>
            <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;">
                <strong>${escHtml(l.name)}</strong><br>
                <span style="color:#6b7280;font-size:12px;">${escHtml(l.sku || '')}</span>
            </td>
            <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right;color:#b45309;font-weight:600;">
                ${escHtml(String(l.on_hand_at_draft ?? ''))}
            </td>
            <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right;color:#6b7280;">
                ${escHtml(String(l.min_point ?? '\u2014'))}
            </td>
            <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600;">
                ${escHtml(String(l.quantity ?? ''))}
            </td>
        </tr>`).join('');

    const more = items.length > 40
        ? `<p style="color:#6b7280;font-size:12px;margin:6px 0 0;">\u2026and ${items.length - 40} more on this order.</p>`
        : '';

    const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;">
        <h2 style="color:#0F2F6B;margin:0 0 4px;">Reorder ready for approval</h2>
        <p style="color:#6b7280;margin:0 0 16px;">
            ${escHtml(companyName)} &middot; ${escHtml(locationName)}
        </p>
        <p style="color:#374151;margin:0 0 16px;">
            ${items.length} item${items.length === 1 ? ' has' : 's have'} reached the shelf minimum and
            ${items.length === 1 ? 'is' : 'are'} queued. <strong>Nothing has been ordered.</strong>
            Review the quantities and approve when you are ready.
        </p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
            <thead>
                <tr style="text-align:left;color:#6b7280;font-size:12px;">
                    <th style="padding:6px 8px;">Item</th>
                    <th style="padding:6px 8px;text-align:right;">On hand</th>
                    <th style="padding:6px 8px;text-align:right;">Min</th>
                    <th style="padding:6px 8px;text-align:right;">Suggested</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
        ${more}
        ${storeUrl ? `<p style="margin:20px 0 0;">
            <a href="${escHtml(storeUrl)}" style="background:#2B9BE8;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;">
                Review the reorder
            </a></p>` : ''}
        <p style="color:#9ca3af;font-size:12px;margin-top:24px;">
            refinishAI Inventory &middot; a CHC Paint and Auto Body Supplies company
        </p>
    </div>`;

    const textLines = [
        `Reorder ready for approval - ${companyName} / ${locationName}`,
        `${items.length} item(s) reached their shelf minimum. Nothing has been ordered yet.`,
        '',
        ...items.slice(0, 40).map(l => `  ${l.sku || ''} ${l.name} - on hand ${l.on_hand_at_draft ?? ''}, suggested ${l.quantity ?? ''}`)
    ];
    if (storeUrl) textLines.push('', storeUrl);

    try {
        const msg = {
            to: recipients,
            from: fromAddress,
            subject: `Reorder ready for approval - ${locationName} (${items.length} item${items.length === 1 ? '' : 's'})`,
            text: textLines.join('\n'),
            html
        };
        if (replyTo) msg.replyTo = replyTo;
        await sgMail.send(msg);
        console.log(`Email: Reorder-raised notice sent to ${recipients.join(', ')} (${items.length} items)`);
        return { sent: true, recipients, count: items.length };
    } catch (err) {
        const errMsg = err.response?.body?.errors?.[0]?.message || err.message;
        console.error('Email: Failed to send reorder notice:', errMsg);
        return { sent: false, reason: 'send_failed', error: errMsg };
    }
}

/**
 * Send a test email to verify configuration.
 */
async function sendTestEmail(toAddress) {
    if (!ensureInit()) {
        return { sent: false, reason: 'not_configured' };
    }
    const fromAddress = process.env.SMTP_FROM || process.env.EMAIL_FROM || 'promo@chcpaint.com';
    try {
        await sgMail.send({
            to: toAddress,
            from: fromAddress,
            subject: 'CHC Platform - Email Test ' + new Date().toISOString(),
            text: 'If you receive this, SendGrid Web API email is working!',
            html: '<h2>CHC Email Test</h2><p>SendGrid Web API delivery is working correctly.</p>'
        });
        return { sent: true, from: fromAddress, to: toAddress };
    } catch (err) {
        const errMsg = err.response?.body?.errors?.[0]?.message || err.message;
        return { sent: false, error: errMsg, code: err.code };
    }
}

/** Escape HTML for email templates */
function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Send an invitation to set a password and activate an account.
 * @param {Object} o
 * @param {string} o.to           recipient email
 * @param {string} o.name         recipient name
 * @param {string} o.inviteUrl    set-password link (carries the token)
 * @param {string} o.context      short label, e.g. 'CHC order desk' or a company name
 * @param {string} [o.invitedBy]  who invited them (name)
 * @param {string} [o.expiresText] e.g. '7 days'
 */
async function sendInvite(o) {
    if (!ensureInit()) {
        console.warn('Email: Skipping invite — SendGrid not configured.');
        return { sent: false, reason: 'not_configured' };
    }
    const to = String(o.to || '').trim();
    if (!to) return { sent: false, reason: 'no_recipient' };

    const fromAddress = process.env.SMTP_FROM || process.env.EMAIL_FROM || 'promo@chcpaint.com';
    const name = escHtml(o.name || 'there');
    const context = escHtml(o.context || 'the CHC portal');
    const invitedBy = o.invitedBy ? `by ${escHtml(o.invitedBy)}` : '';
    const expires = escHtml(o.expiresText || '7 days');
    const url = o.inviteUrl;

    const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">
          <h2 style="color:#111827">You've been invited to ${context}</h2>
          <p>Hi ${name}, you've been invited ${invitedBy} to access ${context}. Click below to set your password and activate your account.</p>
          <p style="margin:28px 0">
            <a href="${url}" style="background:#2563eb;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">Set your password</a>
          </p>
          <p style="color:#6b7280;font-size:13px">This link expires in ${expires}. If the button doesn't work, paste this into your browser:<br>${escHtml(url)}</p>
        </div>`;

    try {
        await sgMail.send({
            to,
            from: fromAddress,
            subject: `Set up your ${o.context || 'CHC'} account`,
            text: `Hi ${o.name || 'there'}, set your password to activate your account: ${url} (expires in ${expires}).`,
            html
        });
        return { sent: true, to };
    } catch (err) {
        const errMsg = err.response?.body?.errors?.[0]?.message || err.message;
        console.error('Invite email failed:', errMsg);
        return { sent: false, error: errMsg };
    }
}

module.exports = { sendOrderNotification, sendInvoiceReady, sendOrderClosed, sendTestEmail, sendLowStockAlert, sendReorderRaised, sendInvite };
