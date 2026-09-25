/**
 * routes/admin-users.js
 *
 * CHC staff accounts, mounted from routes/admin.js at /api/admin/users.
 *
 * Super-admin only. This is the panel that seeds order-desk (and order-manager)
 * staff and invites them to set their own password — deliberately walled off
 * from the order desk itself (order_desk accounts are refused before they
 * reach here).
 *
 * No password is ever set here on creation: a new account is created
 * inactive-until-accepted with a single-use invite token, and the person
 * chooses their own password. A super admin CAN set one directly later, via
 * POST /:id/reset-password (routes/admin-password.js) — e.g. someone on the
 * phone who needs in right now and can't wait on an email — but that always
 * leaves must_change_password set, so the account still ends up on a
 * password only that person knows.
 *
 * ACCESS MODEL (migration 041)
 * An order_desk account can be assigned to more than one CHC branch and,
 * optionally, narrowed to specific customers within them — see
 * utils/order-scope.js (staffBranchIds / staffCompanyIds / staffLocationIds)
 * for how that's resolved into actual order visibility, and
 * utils/recipients.js (branchStaffEmails) for how a branch assignment also
 * puts someone on that branch's order-status emails automatically. The
 * legacy single admin_users.branch_id column is kept in sync as this
 * account's "primary" branch (its first assigned branch, or null) purely so
 * anything still reading it directly — the JWT payload, /whoami, the invite
 * email's context line — keeps showing something sensible; the join tables
 * are the actual source of truth from here on.
 *
 * An order_desk account CAN be saved with no branches or customers assigned
 * at all — it will see nothing, and the list below flags that plainly with a
 * warning rather than refusing the save, because "created but not yet
 * configured" is a real, visible, fixable state, not an error.
 */

const express = require('express');
const crypto = require('crypto');
const { supabaseAdmin } = require('../utils/supabase');
const { requireSuperAdmin } = require('../middleware/auth');
const { stripHtml, validateEmail, isValidUUID } = require('../utils/sanitize');
const { sendInvite } = require('../utils/email');
const { staffBranchIds, staffCompanyIds } = require('../utils/order-scope');

const router = express.Router({ mergeParams: true });

// Everything here is super-admin only.
router.use(requireSuperAdmin);

const ROLES = ['order_desk', 'order_manager', 'super_admin'];
// Only order_desk has anything to assign — order_manager sees every branch
// and customer by role, and super_admin sees everything in the console.
const ASSIGNABLE_ROLES = ['order_desk'];
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

/** Dedupe + validate a body array of ids against a table, dropping anything malformed. */
function cleanIdList(list) {
    if (!Array.isArray(list)) return [];
    return [...new Set(list.filter(id => isValidUUID(id)))];
}

/** Which of these ids actually exist in `table`. Used so a stale/typo'd id is silently dropped, not stored. */
async function existingIds(table, ids) {
    if (!ids.length) return [];
    const { data } = await supabaseAdmin.from(table).select('id').in('id', ids);
    return (data || []).map(r => r.id);
}

/**
 * Replace this account's branch/company assignment rows with exactly the
 * given sets, and keep the legacy branch_id column pointed at the first
 * assigned branch (or null). Only meaningful for order_desk — callers must
 * check the role first.
 */
async function setAssignments(adminUserId, branchIds, companyIds) {
    const branches = await existingIds('supplier_branches', cleanIdList(branchIds));
    const companies = await existingIds('companies', cleanIdList(companyIds));

    await supabaseAdmin.from('admin_user_branches').delete().eq('admin_user_id', adminUserId);
    await supabaseAdmin.from('admin_user_companies').delete().eq('admin_user_id', adminUserId);

    if (branches.length) {
        await supabaseAdmin.from('admin_user_branches')
            .insert(branches.map(branch_id => ({ admin_user_id: adminUserId, branch_id })));
    }
    if (companies.length) {
        await supabaseAdmin.from('admin_user_companies')
            .insert(companies.map(company_id => ({ admin_user_id: adminUserId, company_id })));
    }

    await supabaseAdmin.from('admin_users')
        .update({ branch_id: branches[0] || null, updated_at: new Date().toISOString() })
        .eq('id', adminUserId);

    return { branch_ids: branches, company_ids: companies };
}

/**
 * A clear status + any warning worth a person's attention, computed the same
 * way for every account so the list is honest about who can actually get in.
 * Never a hard block on saving — just visible.
 */
function describeAccount(u, branchCount, companyCount) {
    const now = Date.now();
    let status;
    if (!u.is_active) {
        status = 'disabled';
    } else if (!u.password_hash) {
        status = (u.invite_expires_at && new Date(u.invite_expires_at).getTime() < now)
            ? 'invite_expired' : 'invited';
    } else if (u.must_change_password) {
        status = 'password_reset_pending';
    } else {
        status = 'active';
    }

    const warnings = [];
    if (status === 'invite_expired') {
        warnings.push('Invite link expired before they set a password — resend it, or set one for them directly.');
    }
    if (status === 'password_reset_pending') {
        warnings.push('Password was reset for them and they haven’t signed in to choose a new one yet.');
    }
    if (u.role === 'order_desk' && u.is_active && branchCount === 0 && companyCount === 0) {
        warnings.push('Not assigned to any branch — this account cannot see any orders yet.');
    }

    return { status, warning: warnings[0] || null };
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

/** List CHC staff, with a clear status/warning and their full branch + customer assignment. */
router.get('/', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('admin_users')
            .select('id, email, name, role, branch_id, is_active, is_branch_manager, last_login, password_hash, invite_expires_at, must_change_password')
            .order('created_at', { ascending: true });
        if (error) throw error;

        const users = data || [];
        const ids = users.map(u => u.id);

        // Two batch queries instead of two-per-user -- this list is small (CHC
        // staff, not customers) but there is no reason to make it N+1.
        let branchRows = [], companyRows = [];
        if (ids.length) {
            const [{ data: br }, { data: cr }] = await Promise.all([
                supabaseAdmin.from('admin_user_branches').select('admin_user_id, branch_id, supplier_branches(name)').in('admin_user_id', ids),
                supabaseAdmin.from('admin_user_companies').select('admin_user_id, company_id, companies(name)').in('admin_user_id', ids)
            ]);
            branchRows = br || []; companyRows = cr || [];
        }
        const branchesFor = {}, companiesFor = {};
        branchRows.forEach(r => { (branchesFor[r.admin_user_id] ||= []).push({ id: r.branch_id, name: r.supplier_branches?.name || '' }); });
        companyRows.forEach(r => { (companiesFor[r.admin_user_id] ||= []).push({ id: r.company_id, name: r.companies?.name || '' }); });

        const shaped = users.map(u => {
            const branches = branchesFor[u.id] || [];
            const companies = companiesFor[u.id] || [];
            const { status, warning } = describeAccount(u, branches.length, companies.length);
            return {
                id: u.id,
                email: u.email,
                name: u.name,
                role: u.role,
                // Kept for anything still reading the single legacy field --
                // always this account's first assigned branch (see setAssignments).
                branch_id: u.branch_id,
                branch_name: branches[0]?.name || null,
                branches,
                companies,
                is_active: u.is_active,
                // Meaningful for order_desk only — super_admin and order_manager
                // already qualify for manager-level settings (like the delivery
                // fee toggle) by role. See routes/delivery-fee-admin.js.
                is_branch_manager: u.is_branch_manager === true,
                last_login: u.last_login,
                status,
                warning
            };
        });
        res.json({ users: shaped });
    } catch (err) {
        console.error('Admin user list error:', err);
        res.status(500).json({ error: 'Failed to load users.' });
    }
});

/** This account's full branch + customer assignment, for the edit-access picker. */
router.get('/:id/assignments', async (req, res) => {
    try {
        const id = req.params.id;
        if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid user id.' });
        const { data: user } = await supabaseAdmin.from('admin_users').select('id, branch_id, role').eq('id', id).maybeSingle();
        if (!user) return res.status(404).json({ error: 'User not found.' });

        const [branch_ids, company_ids] = await Promise.all([staffBranchIds(user), staffCompanyIds(user)]);
        res.json({ branch_ids, company_ids, assignable: ASSIGNABLE_ROLES.includes(user.role) });
    } catch (err) {
        console.error('Assignment load error:', err);
        res.status(500).json({ error: 'Failed to load this account’s access.' });
    }
});

/** Replace this account's branch + customer assignment. */
router.put('/:id/assignments', async (req, res) => {
    try {
        const id = req.params.id;
        if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid user id.' });
        const { data: user } = await supabaseAdmin.from('admin_users').select('id, role').eq('id', id).maybeSingle();
        if (!user) return res.status(404).json({ error: 'User not found.' });
        if (!ASSIGNABLE_ROLES.includes(user.role)) {
            return res.status(400).json({ error: 'Only order-desk accounts can be assigned to specific branches or customers.' });
        }

        const result = await setAssignments(id, req.body.branch_ids, req.body.company_ids);
        await logAction(req.admin.id, 'admin_user_access_updated', id, result, req.ip);
        res.json({ message: 'Access updated.', ...result });
    } catch (err) {
        console.error('Assignment update error:', err);
        res.status(500).json({ error: 'Failed to update this account’s access.' });
    }
});

/** Create + invite a CHC staff account. */
router.post('/', async (req, res) => {
    try {
        const name = stripHtml(req.body.name || '').trim();
        const email = stripHtml(req.body.email || '').trim().toLowerCase();
        const role = String(req.body.role || 'order_desk');
        // Prefer branch_ids/company_ids (arrays); fall back to the legacy
        // single branch_id so any caller still sending it keeps working.
        const branchIds = Array.isArray(req.body.branch_ids)
            ? req.body.branch_ids
            : (req.body.branch_id ? [req.body.branch_id] : []);
        const companyIds = req.body.company_ids || [];

        if (!name) return res.status(400).json({ error: 'A name is required.' });
        if (!validateEmail(email)) return res.status(400).json({ error: 'A valid email is required.' });
        if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });

        // Unique email across admin users.
        const { data: existing } = await supabaseAdmin.from('admin_users').select('id').eq('email', email).maybeSingle();
        if (existing) return res.status(409).json({ error: 'An account with that email already exists.' });

        const { token, expires } = newInvite();

        const { data: created, error } = await supabaseAdmin
            .from('admin_users')
            .insert({
                email, name, role,
                branch_id: null,
                company_id: null,
                password_hash: null,
                is_active: true,
                invite_token: token,
                invite_expires_at: expires,
                created_by: req.admin.id
            })
            .select('id, email, name, role')
            .single();
        if (error) throw error;

        let assignment = { branch_ids: [], company_ids: [] };
        if (ASSIGNABLE_ROLES.includes(role) && (branchIds.length || companyIds.length)) {
            assignment = await setAssignments(created.id, branchIds, companyIds);
        }

        const invite = await sendInvite({
            to: email, name,
            inviteUrl: `${baseUrl()}/set-password.html?token=${token}&kind=admin`,
            context: 'CHC order desk',
            invitedBy: req.admin.name,
            expiresText: `${INVITE_TTL_DAYS} days`
        });

        await logAction(req.admin.id, 'admin_user_invited', created.id, { email, role, ...assignment }, req.ip);
        res.status(201).json({
            message: `Invite sent to ${email}.`,
            user: { ...created, ...assignment },
            email_sent: invite.sent
        });
    } catch (err) {
        console.error('Admin user create error:', err);
        res.status(500).json({ error: 'Failed to create that user.' });
    }
});

/** Update role / active / branch-manager flag. Branch + customer assignment is PUT /:id/assignments. */
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
        if (req.body.email !== undefined) {
            const email = stripHtml(req.body.email).trim().toLowerCase();
            if (!validateEmail(email)) return res.status(400).json({ error: 'A valid email is required.' });
            const { data: existing } = await supabaseAdmin
                .from('admin_users').select('id').eq('email', email).neq('id', id).maybeSingle();
            if (existing) return res.status(409).json({ error: 'Another account already uses that email.' });
            patch.email = email;
        }
        if (req.body.is_active !== undefined) patch.is_active = req.body.is_active === true;
        let roleChangedAwayFromAssignable = false;
        if (req.body.role !== undefined) {
            if (!ROLES.includes(req.body.role)) return res.status(400).json({ error: 'Invalid role.' });
            patch.role = req.body.role;
            if (!ASSIGNABLE_ROLES.includes(req.body.role)) roleChangedAwayFromAssignable = true;
        }
        // A branch manager: an order-desk account also trusted with certain
        // account-level settings (see routes/delivery-fee-admin.js) without
        // promoting them to order_manager or super_admin, which would also
        // widen their console access beyond Orders. Meaningless for any
        // other role, which already qualifies by role — clear it there so
        // the flag can't outlive a later promotion and mislead someone
        // reading this account's row.
        if (req.body.is_branch_manager !== undefined) {
            patch.is_branch_manager = req.body.is_branch_manager === true;
        }
        if (patch.role && !ASSIGNABLE_ROLES.includes(patch.role)) {
            patch.is_branch_manager = false;
        }

        patch.updated_at = new Date().toISOString();
        const { data, error } = await supabaseAdmin
            .from('admin_users').update(patch).eq('id', id)
            .select('id, email, name, role, branch_id, is_active, is_branch_manager').single();
        if (error) {
            if (error.code === '23505') return res.status(409).json({ error: 'Another account already uses that email.' });
            throw error;
        }

        // Moving off order_desk (e.g. promoted to super_admin) — a role that no
        // longer has a picker shouldn't keep stale assignment rows sitting
        // around implying it's still scoped by them.
        if (roleChangedAwayFromAssignable) {
            await setAssignments(id, [], []);
            data.branch_id = null;
        }

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

/**
 * Whether this account is the recorded actor on an audit-log entry or a
 * catalogue import. Both columns have no ON DELETE clause (deliberately —
 * see the file header), so a hard delete would fail here anyway; checking
 * first lets us give a clear reason instead of a raw constraint error. Every
 * other attribution column this account could hold (who handled an order,
 * uploaded an invoice, imported the master file, ...) is ON DELETE SET NULL,
 * and in practice an account that did any of that has also logged at least
 * one audit-log action — so this is also a reasonable proxy for "this
 * account never did anything worth keeping a record of."
 */
async function hasProtectedHistory(adminUserId) {
    const [{ count: auditCount }, { count: uploadCount }] = await Promise.all([
        supabaseAdmin.from('audit_log').select('id', { count: 'exact', head: true }).eq('admin_id', adminUserId),
        supabaseAdmin.from('catalog_uploads').select('id', { count: 'exact', head: true }).eq('admin_id', adminUserId)
    ]);
    return (auditCount || 0) > 0 || (uploadCount || 0) > 0;
}

/**
 * Permanently remove an account — only once it is already deactivated, so
 * nobody can skip the safer, reversible step by mistake. Refused if this
 * account has any recorded history (see hasProtectedHistory): it stays
 * deactivated instead, same as today, with a clear reason why.
 */
router.delete('/:id/purge', async (req, res) => {
    try {
        const id = req.params.id;
        if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid user id.' });
        if (id === req.admin.id) return res.status(400).json({ error: 'You cannot delete your own account.' });

        const { data: user } = await supabaseAdmin.from('admin_users').select('id, email, is_active').eq('id', id).maybeSingle();
        if (!user) return res.status(404).json({ error: 'User not found.' });
        if (user.is_active) return res.status(400).json({ error: 'Deactivate this account before deleting it.' });

        if (await hasProtectedHistory(id)) {
            return res.status(409).json({ error: 'This account has activity on record, so it can’t be permanently deleted — it stays deactivated.' });
        }

        const { error } = await supabaseAdmin.from('admin_users').delete().eq('id', id);
        if (error) throw error;

        await logAction(req.admin.id, 'admin_user_deleted', id, { email: user.email }, req.ip);
        res.json({ message: 'Account permanently deleted.' });
    } catch (err) {
        console.error('Admin user purge error:', err);
        res.status(500).json({ error: 'Failed to delete that user.' });
    }
});

/** Deactivate (soft). Accounts are never hard-deleted while active — audit trails reference them; see DELETE /:id/purge for the gated, permanent version. */
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
