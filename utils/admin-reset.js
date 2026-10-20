/**
 * utils/admin-reset.js
 *
 * Self-service "forgot password" for CHC staff (admin_users) -- the sign-in at
 * /admin had no way for a person to recover their own account, so every locked
 * out staff member became a support request.
 *
 * It uses the same single-use token and set-password page as an invitation
 * (POST /api/auth/admin-accept-invite), so there is one way to choose a password,
 * not two.
 *
 * Rules that matter:
 *   * The caller always gets the same answer, whether or not the address has an
 *     account, so this cannot be used to find out who works here.
 *   * Only an ACTIVE account gets a link, and a link is not re-issued more often
 *     than every COOLDOWN_MINUTES, so the form cannot be used to flood someone.
 *   * A link lives RESET_TTL_HOURS, not the 7 days an invitation gets.
 *   * If the email cannot be sent, the failure is logged with the real reason.
 */

const crypto = require('crypto');
const { supabaseAdmin } = require('./supabase');
const { stripHtml, validateEmail } = require('./sanitize');
const { sendInvite } = require('./email');

const RESET_TTL_HOURS = 24;
const COOLDOWN_MINUTES = 2;

const baseUrl = () =>
    (process.env.APP_URL || process.env.PUBLIC_URL || 'https://chcsale.com').replace(/\/$/, '');

const setPasswordUrl = token => `${baseUrl()}/set-password.html?token=${token}&kind=admin`;

function newToken(hours = RESET_TTL_HOURS) {
    return {
        token: crypto.randomBytes(32).toString('hex'),
        expires: new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
    };
}

/**
 * @param {Object} o
 * @param {string} o.email
 * @param {Object} [o.distributor]  the distributor this request arrived on, if any
 * @returns {Promise<{sent:boolean, reason?:string, error?:string}>}
 *   for tests and logs only -- never shown to the person who asked
 */
async function requestAdminPasswordReset({ email, distributor }) {
    email = stripHtml(email || '').trim().toLowerCase();
    if (!validateEmail(email)) return { sent: false, reason: 'bad_email' };

    const { data: admin } = await supabaseAdmin
        .from('admin_users')
        .select('id, email, name, role, is_active, password_hash, distributor_id, invite_token, updated_at')
        .eq('email', email)
        .maybeSingle();

    if (!admin) return { sent: false, reason: 'no_user' };
    if (!admin.is_active) return { sent: false, reason: 'inactive' };

    // Same rule as sign-in: staff belong to one distributor, platform admins to none.
    if (distributor && admin.role !== 'platform_admin'
        && admin.distributor_id && admin.distributor_id !== distributor.id) {
        return { sent: false, reason: 'other_distributor' };
    }

    if (admin.invite_token && admin.updated_at
        && Date.now() - new Date(admin.updated_at).getTime() < COOLDOWN_MINUTES * 60 * 1000) {
        return { sent: false, reason: 'cooldown' };
    }

    const { token, expires } = newToken();
    const { error } = await supabaseAdmin.from('admin_users')
        .update({ invite_token: token, invite_expires_at: expires, updated_at: new Date().toISOString() })
        .eq('id', admin.id);
    if (error) throw error;

    const mail = await sendInvite({
        to: admin.email, name: admin.name,
        inviteUrl: setPasswordUrl(token),
        context: 'CHC order console',
        expiresText: `${RESET_TTL_HOURS} hours`,
        reset: !!admin.password_hash
    });
    return mail.sent ? { sent: true } : { sent: false, reason: 'email_failed', error: mail.error || mail.reason };
}

module.exports = { requestAdminPasswordReset, newToken, setPasswordUrl, RESET_TTL_HOURS, COOLDOWN_MINUTES };
