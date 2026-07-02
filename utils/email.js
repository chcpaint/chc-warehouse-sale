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

    const { to, order, companyName, contactName, contactEmail, contactPhone, poNumber, location, notes } = options;

    // `to` may be a single address or an array of manager addresses
    const recipients = (Array.isArray(to) ? to : [to]).map(x => String(x || '').trim()).filter(Boolean);
    if (!recipients.length) {
        console.warn('Email: No notification email configured for this company.');
        return { sent: false, reason: 'no_recipient' };
    }

    const fromAddress = process.env.SMTP_FROM || process.env.EMAIL_FROM || 'promo@chcpaint.com';

    // Build line items HTML
    const itemsHtml = (order.items || []).map(item => `
        <tr>
            <td style="padding: 8px; border-bottom: 1px solid #eee;">${escHtml(item.name)}</td>
            <td style="padding: 8px; border-bottom: 1px solid #eee;">${escHtml(item.sku || '-')}</td>
            <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: center;">${item.quantity}</td>
            <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right;">$${Number(item.unit_price).toFixed(2)}</td>
            <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right;">$${Number(item.subtotal).toFixed(2)}</td>
        </tr>
    `).join('');

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1e40af; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
            <h2 style="margin: 0;">New Order Received</h2>
            <p style="margin: 5px 0 0; opacity: 0.9;">Order #${escHtml(order.order_number || order.id)}</p>
        </div>
        <div style="padding: 20px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
            <h3 style="color: #374151; margin-top: 0;">Company: ${escHtml(companyName)}</h3>

            ${poNumber ? `<div style="margin-bottom: 15px; padding: 12px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 6px;">
                <strong style="font-size: 16px; color: #1e40af;">PO #: ${escHtml(poNumber)}</strong>
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
                        <td colspan="4" style="padding: 10px 8px; text-align: right; font-weight: bold;">Total:</td>
                        <td style="padding: 10px 8px; text-align: right; font-weight: bold; font-size: 16px; color: #1e40af;">$${Number(order.total).toFixed(2)}</td>
                    </tr>
                </tfoot>
            </table>

            ${notes ? `<div style="margin-top: 15px; padding: 12px; background: #f9fafb; border-radius: 6px;"><strong>Notes:</strong> ${escHtml(notes)}</div>` : ''}

            <p style="margin-top: 20px; color: #9ca3af; font-size: 12px;">This is an automated notification from CHC Paint & Auto Body Supplies ordering platform.</p>
        </div>
    </div>`;

    const textItems = (order.items || []).map(i => `  - ${i.name} (${i.sku || 'N/A'}) x${i.quantity} = $${Number(i.subtotal).toFixed(2)}`).join('\n');
    const text = `New Order #${order.order_number || order.id}\nCompany: ${companyName}${poNumber ? `\nPO #: ${poNumber}` : ''}\nOrdered by: ${contactName} (${contactEmail})${location ? `\nLocation: ${location}` : ''}\n\nItems:\n${textItems}\n\nTotal: $${Number(order.total).toFixed(2)}${notes ? `\n\nNotes: ${notes}` : ''}`;

    try {
        await sgMail.send({
            to: recipients,
            from: fromAddress,
            subject: `${companyName} Ordering, ${order.order_number || order.id}${location ? ', ' + location : ''}`,
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
    const { to, order, companyName, retrieveUrl } = options;
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
    const { to, order, companyName } = options;
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

module.exports = { sendOrderNotification, sendInvoiceReady, sendOrderClosed, sendTestEmail };
