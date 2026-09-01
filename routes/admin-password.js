/**
 * routes/admin-password.js
 *
 * Changing an admin password, mounted from routes/admin.js at /api/admin.
 *
 * WHY THIS FILE EXISTS
 *
 * The console has had a "Change Password" button for some time. It calls
 * PUT /me/password, and the reset dialog calls POST /users/:id/reset-password.
 * Neither endpoint existed anywhere in the codebase — both returned 404, so the
 * button had never worked. Nobody noticed, because nobody had needed to change
 * a password until eight branch staff were issued the same one.
 *
 * That is also why the forced-change flag could not simply be switched on: it
 * would have locked people out of a console with no way to satisfy it.
 *
 * THE RULES THAT MATTER
 *
 *   * Changing your own password requires the current one. Otherwise a stolen
 *     token — which is all a shared password really is — becomes a permanent
 *     account takeover rather than a temporary one.
 *   * A reset by someone else always sets must_change_password. If an admin
 *     picks the password, the owner has not chosen it yet, and the audit trail
 *     cannot honestly attribute actions until they do.
 *   * Changing your own password CLEARS the flag. That is the only way it
 *     clears.
 */

const express = require('express');
const bcrypt = require('bcrypt');
const { supabaseAdmin } = require('../utils/supabase');
const { requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();

/** Same policy as invite acceptance, kept in step deliberately. */
function weakPassword(pw) {
    return !pw || pw.length < 8 || !/[A-Z]/.test(pw) || !/[a-z]/.test(pw) || !/[0-9]/.test(pw);
}
const PW_RULE = 'Password must be at least 8 characters with uppercase, lowercase, and a number.';

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
 * PUT /api/admin/me/password
 * body: { current_password, new_password }
 *
 * Reachable while must_change_password is set — it is one of only two routes
 * that are, since it is the way out of that state.
 */
router.put('/me/password', async (req, res) => {
    try {
        const current = req.body?.current_password;
        const next = req.body?.new_password;

        if (!current || !next) {
            return res.status(400).json({ error: 'Current and new password are both required.' });
        }
        if (weakPassword(next)) {
            return res.status(400).json({ error: PW_RULE });
        }
        if (current === next) {
            return res.status(400).json({
                error: 'The new password must be different from the current one.'
            });
        }

        const { data: me } = await supabaseAdmin
            .from('admin_users')
            .select('id, email, password_hash')
            .eq('id', req.admin.id)
            .single();

        if (!me?.password_hash) {
            return res.status(400).json({ error: 'This account has no password set.' });
        }

        // The current password is checked even mid-forced-change. The flag says
        // "this password was not chosen by you", not "anyone may replace it".
        const ok = await bcrypt.compare(current, me.password_hash);
        if (!ok) {
            return res.status(401).json({ error: 'Current password is incorrect.' });
        }

        const { error } = await supabaseAdmin
            .from('admin_users')
            .update({
                password_hash: await bcrypt.hash(next, 12),
                must_change_password: false,
                updated_at: new Date().toISOString()
            })
            .eq('id', me.id);

        if (error) throw error;

        // No password material in the log, only that it happened.
        await logAction(req.admin.id, 'password_changed', 'admin_user', me.id,
            { email: me.email, self_service: true }, req.ip);

        res.json({ changed: true, must_change_password: false });
    } catch (err) {
        console.error('Change password error:', err);
        res.status(500).json({ error: 'Failed to change password.' });
    }
});

/**
 * POST /api/admin/users/:id/reset-password
 * body: { new_password }
 * Super admin only.
 *
 * Always leaves must_change_password set: a password chosen by somebody else is
 * a temporary key, not the person's own.
 */
router.post('/users/:id/reset-password', requireSuperAdmin, async (req, res) => {
    try {
        const next = req.body?.new_password;
        if (weakPassword(next)) {
            return res.status(400).json({ error: PW_RULE });
        }

        const { data: target } = await supabaseAdmin
            .from('admin_users')
            .select('id, email, name')
            .eq('id', req.params.id)
            .maybeSingle();

        if (!target) return res.status(404).json({ error: 'User not found.' });

        const { error } = await supabaseAdmin
            .from('admin_users')
            .update({
                password_hash: await bcrypt.hash(next, 12),
                must_change_password: true,
                updated_at: new Date().toISOString()
            })
            .eq('id', target.id);

        if (error) throw error;

        await logAction(req.admin.id, 'password_reset_for_user', 'admin_user', target.id,
            { email: target.email, must_change_password: true }, req.ip);

        res.json({
            reset: true,
            must_change_password: true,
            message: `${target.name} will be asked to choose their own password at next sign-in.`
        });
    } catch (err) {
        console.error('Reset password error:', err);
        res.status(500).json({ error: 'Failed to reset password.' });
    }
});

module.exports = router;
