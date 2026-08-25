/**
 * routes/admin-users.js
 *
 * CHC staff accounts, mounted from routes/admin.js at /api/admin/users.
 *
 * Super-admin only. This is the panel that seeds order-desk staff by branch and
 * invites them to set their own password — deliberately walled off from the
 * order desk itself (order_desk accounts are refused before they reach here).
 *
 * No password is ever set here: a new account is created inactive-until-accepted
 * with a single-use invite token, and the person chooses their own password.
 */

const express = require('express');
const crypto = require('crypto');
const { supabaseAdmin } = require('../utils/supabase');
const { requireSuperAdmin } = require('../middleware/auth');
const { stripHtml, validateEmail, isValidUUID } = require('../utils/sanitize');
const { sendInvite } = require('../utils/email');

const router = express.Router({ mergeParams: true });

// Everything here is super-admin only.
router.use(requireSuperAdmin);

const ROLES = ['order_desk', 'super_admin'];
const INVITE_TTL_DAYS = 7;
const baseUrl = () =>
    (process.env.APP_URL || process.env.PUBLIC_URL || 'https://chcsale.com').replace(/\/$/, '');

function newInvite() {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    return { token, expires };
}

async function logAction(adminId, action, entityId, details, ip) {
    try {
        await supabaseAdmin.from('audit_log').insert({
            admin_id: adminId, action, entity_type: 'admin_user',
            entity_id: entityId, details, ip_address: ip
        });
    } catch (err) { console.error('Audit log write failed:', err); }
}

/** Branches, for the "assign to branch" picker. */
router.get('/branches', async (req, res) => {
    try {
        const { data } = await supabaseAdmin
            .from('supplier_branches')
            .select('id, name')
            .order('name');
        res.json({ branches: data || [] });
    } catch (err) {
        console.error('Branch list error:', err);
        res.status(500).json({ error: 'Failed to load branches.' });
    }
});

/** List CHC staff. */
router.get('/', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('admin_users')
            .select('id, email, name, role, branch_id, is_active, last_login, password_hash, invite_expires_at, supplier_branches:branch_id (id, name)')
            .order('created_at', { ascending: true });
        if (error) throw error;

        const users = (data || []).map(u => ({
            id: u.id,
            email: u.email,
            name: u.name,
            role: u.role,
            branch_id: u.branch_id,
            branch_name: u.supplier_branches?.name || null,
            is_active: u.is_active,
            last_login: u.last_login,
            // Never leak the hash; just whether they've activated.
            status: u.password_hash ? (u.is_active ? 'active' : 'disabled') : 'invited'
        }));
        res.json({ users });
    } catch (err) {
        console.error('Admin user list error:', err);
        res.status(500).json({ error: 'Failed to load users.' });
    }
});

/** Create + invite a CHC staff account. */
router.post('/', async (req, res) => {
    try {
        const name = stripHtml(req.body.name || '').trim();
        const email = stripHtml(req.body.email || '').trim().toLowerCase();
        const role = String(req.body.role || 'order_desk');
        const branchId = req.body.branch_id || null;

        if (!name) return res.status(400).json({ error: 'A name is required.' });
        if (!validateEmail(email)) return res.status(400).json({ error: 'A valid email is required.' });
        if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });

        if (role === 'order_desk') {
            if (!isValidUUID(branchId)) return res.status(400).json({ error: 'Order-desk staff must be assigned to a branch.' });
            const { data: branch } = await supabaseAdmin.from('supplier_branches').select('id').eq('id', branchId).maybeSingle();
            if (!branch) return res.status(400).json({ error: 'That branch does not exist.' });
        }

        // Unique email across admin users.
        const { data: existing } = await supabaseAdmin.from('admin_users').select('id').eq('email', email).maybeSingle();
        if (existing) return res.status(409).json({ error: 'An account with that email already exists.' });

        const { token, expires } = newInvite();

        const { data: created, error } = await supabaseAdmin
            .from('admin_users')
            .insert({
                email, name, role,
                branch_id: role === 'order_desk' ? branchId : null,
                company_id: null,
                password_hash: null,
                is_active: true,
                invite_token: token,
                invite_expires_at: expires,
                created_by: req.admin.id
            })
            .select('id, email, name, role, branch_id')
            .single();
        if (error) throw error;

        const invite = await sendInvite({
            to: email, name,
            inviteUrl: `${baseUrl()}/set-password.html?token=${token}&kind=admin`,
            context: 'CHC order desk',
            invitedBy: req.admin.name,
            expiresText: `${INVITE_TTL_DAYS} days`
        });

        await logAction(req.admin.id, 'admin_user_invited', created.id, { email, role, branch_id: created.branch_id }, req.ip);
        res.status(201).json({ message: `Invite sent to ${email}.`, user: created, email_sent: invite.sent });
    } catch (err) {
        console.error('Admin user create error:', err);
        res.status(500).json({ error: 'Failed to create that user.' });
    }
});

/** Update role / branch / active. */
router.put('/:id', async (req, res) => {
    try {
        const id = req.params.id;
        if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid user id.' });
        if (id === req.admin.id && req.body.is_active === false) {
            return res.status(400).json({ error: 'You cannot deactivate your own account.' });
        }
        if (id === req.admin.id && req.body.role && req.body.role !== 'super_admin') {
            return res.status(400).json({ error: 'You cannot change your own role.' });
        }

        const patch = {};
        if (req.body.name !== undefined) patch.name = stripHtml(req.body.name).trim();
        if (req.body.is_active !== undefined) patch.is_active = req.body.is_active === true;
        if (req.body.role !== undefined) {
            if (!ROLES.includes(req.body.role)) return res.status(400).json({ error: 'Invalid role.' });
            patch.role = req.body.role;
        }
        if (req.body.branch_id !== undefined) {
            const b = req.body.branch_id || null;
            if (b && !isValidUUID(b)) return res.status(400).json({ error: 'Invalid branch id.' });
            patch.branch_id = b;
        }
        // Order-desk must keep a branch.
        const effectiveRole = patch.role || (await supabaseAdmin.from('admin_users').select('role').eq('id', id).maybeSingle()).data?.role;
        if (effectiveRole === 'order_desk') {
            const branch = patch.branch_id !== undefined ? patch.branch_id : undefined;
            if (branch === null) return res.status(400).json({ error: 'Order-desk staff must be assigned to a branch.' });
        } else if (patch.role === 'super_admin') {
            patch.branch_id = null;
        }

        patch.updated_at = new Date().toISOString();
        const { data, error } = await supabaseAdmin
            .from('admin_users').update(patch).eq('id', id)
            .select('id, email, name, role, branch_id, is_active').single();
        if (error) throw error;

        await logAction(req.admin.id, 'admin_user_updated', id, patch, req.ip);
        res.json({ message: 'Saved.', user: data });
    } catch (err) {
        console.error('Admin user update error:', err);
        res.status(500).json({ error: 'Failed to update that user.' });
    }
});

/** Resend / regenerate an invite (also serves as a password reset). */
router.post('/:id/resend-invite', async (req, res) => {
    try {
        const id = req.params.id;
        if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid user id.' });
        const { data: user } = await supabaseAdmin.from('admin_users').select('id, email, name').eq('id', id).maybeSingle();
        if (!user) return res.status(404).json({ error: 'User not found.' });

        const { token, expires } = newInvite();
        await supabaseAdmin.from('admin_users')
            .update({ invite_token: token, invite_expires_at: expires, updated_at: new Date().toISOString() })
            .eq('id', id);

        const invite = await sendInvite({
            to: user.email, name: user.name,
            inviteUrl: `${baseUrl()}/set-password.html?token=${token}&kind=admin`,
            context: 'CHC order desk',
            invitedBy: req.admin.name,
            expiresText: `${INVITE_TTL_DAYS} days`
        });
        await logAction(req.admin.id, 'admin_user_reinvited', id, { email: user.email }, req.ip);
        res.json({ message: `Invite re-sent to ${user.email}.`, email_sent: invite.sent });
    } catch (err) {
        console.error('Resend invite error:', err);
        res.status(500).json({ error: 'Failed to resend the invite.' });
    }
});

/** Deactivate (soft). Accounts are never hard-deleted — audit trails reference them. */
router.delete('/:id', async (req, res) => {
    try {
        const id = req.params.id;
        if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid user id.' });
        if (id === req.admin.id) return res.status(400).json({ error: 'You cannot deactivate your own account.' });

        const { error } = await supabaseAdmin
            .from('admin_users').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', id);
        if (error) throw error;

        await logAction(req.admin.id, 'admin_user_deactivated', id, {}, req.ip);
        res.json({ message: 'Account deactivated.' });
    } catch (err) {
        console.error('Admin user deactivate error:', err);
        res.status(500).json({ error: 'Failed to deactivate that user.' });
    }
});

module.exports = router;
