const nodemailer = require('nodemailer');

/**
 * Create a reusable SMTP transporter from environment variables.
 * Returns null if SMTP is not configured.
 */
function createTransporter() {
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
        console.warn('Email: SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS env vars.');
        return null;
    }

    return nodemailer.createTransport({
        host: SMTP_HOST,
        port: parseInt(SMTP_PORT) || 587,
        secure: parseInt(SMTP_PORT) === 465,
        auth: {
            user: SMTP_USER,
            pass: SMTP_PASS
        }
    });
}

let transporter = null;

function getTransporter() {
    if (!transporter) {
        transporter = createTransporter();
    }
    return transporter;
}

/**
 * Send an order notification email.
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
    const transport = getTransporter();
    if (!transport) {
        console.warn('Email: Skipping order notification — SMTP not configured.');
        return { sent: false, reason: 'smtp_not_configured' };
    }

    const { to, order, companyName, contactName, contactEmail, contactPhone, location, notes } = options;

    if (!to) {
        console.warn('Email: No notification email configured for this company.');
        return { sent: false, reason: 'no_recipient' };
    }

    const fromAddress = process.env.SMTP_FROM || process.env.EMAIL_FROM || process.env.SMTP_USER;

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
    const text = `New Order #${order.order_number || order.id}\nCompany: ${companyName}\nOrdered by: ${contactName} (${contactEmail})${location ? `\nLocation: ${location}` : ''}\n\nItems:\n${textItems}\n\nTotal: $${Number(order.total).toFixed(2)}${notes ? `\n\nNotes: ${notes}` : ''}`;

    try {
        await transport.sendMail({
            from: fromAddress,
            to,
            subject: `New Order #${order.order_number || order.id} from ${companyName}`,
            text,
            html
        });
        console.log(`Email: Order notification sent to ${to} for order ${order.order_number || order.id}`);
        return { sent: true };
    } catch (err) {
        console.error('Email: Failed to send order notification:', err.message);
        return { sent: false, reason: 'send_failed', error: err.message };
    }
}

/** Escape HTML for email templates */
function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { sendOrderNotification, getTransporter };
