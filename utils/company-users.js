/**
 * utils/company-users.js
 *
 * Shared logic for a company's customer users, used by BOTH entry points:
 *   - CHC admin seeding   (routes/company-users-admin.js)
 *   - the company owner    (routes/company-users-store.js)
 *
 * Keeping the rules here means "who may exist, with what role, invited how"
 * has one definition no matter who does the inviting.
 */

const crypto = require('crypto');
const { supabaseAdmin } = require('./supabase');
const { sendInvite } = require('./email');
const { stripHtml, validateEmail, isValidUUID } = require('./sanitize');
const { resolveGroupId } = require('./people-activity');

const ROLES = ['member', 'owner'];
const INVITE_TTL_DAYS = 7;
const baseUrl = () =>
    (process.env.APP_URL || process.env.PUBLIC_URL || 'https://chcsale.com').replace(/\/$/, '');

function newInvite() {
    return {
        token: crypto.randomBytes(32).toString('hex'),
        expires: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()
    };
}

async function listUsers(companyId) {
    // Groups arrived with migration 045. Until it is applied to a database the
    // group columns do not exist, and this list must keep working without them
    // -- an error here would otherwise show as "no users".
    const base = 'id, email, name, role, location_id, is_active, last_login, password_hash, company_locations:location_id (id, name)';
    let { data, error } = await supabaseAdmin
        .from('company_users')
        .select(`${base}, group_id, company_user_groups:group_id (id, name)`)
        .eq('company_id', companyId)
        .order('created_at', { ascending: true });
    if (error) {
        ({ data } = await supabaseAdmin
            .from('company_users').select(base)
            .eq('company_id', companyId)
            .order('created_at', { ascending: true }));
    }

    return (data || []).map(u => ({
        id: u.id, email: u.email, name: u.name, role: u.role,
        location_id: u.location_id,
        location_name: u.company_locations?.name || null,
        group_id: u.group_id || null,
        group_name: u.company_user_groups?.name || null,
        is_active: u.is_active, last_login: u.last_login,
        status: u.password_hash ? (u.is_active ? 'active' : 'disabled') : 'invited'
    }));
}

/**
 * Create a customer user and send them a set-password invite.
 * @returns {{status:number, body:object}}
 */
async function createUser({ company, name, email, locationId, groupId, role, invitedBy, invitedByType }) {
    name = stripHtml(name || '').trim();
    email = stripHtml(email || '').trim().toLowerCase();
    role = ROLES.includes(role) ? role : 'member';

    if (!name) return { status: 400, body: { error: 'A name is required.' } };
    if (!validateEmail(email)) return { status: 400, body: { error: 'A valid email is required.' } };

    if (locationId) {
        if (!isValidUUID(locationId)) return { status: 400, body: { error: 'Invalid location.' } };
        const { data: loc } = await supabaseAdmin
            .from('company_locations').select('id').eq('id', locationId).eq('company_id', company.id).maybeSingle();
        if (!loc) return { status: 400, body: { error: 'That location is not part of this company.' } };
    }

    const group = await resolveGroupId(company.id, groupId);
    if (!group.ok) return { status: 400, body: { error: group.error } };

    const { data: existing } = await supabaseAdmin
        .from('company_users').select('id').eq('company_id', company.id).ilike('email', email).maybeSingle();
    if (existing) return { status: 409, body: { error: 'A user with that email already exists for this company.' } };

    const { token, expires } = newInvite();
    const { data: created, error } = await supabaseAdmin
        .from('company_users')
        .insert({
            company_id: company.id, email, name, role,
            location_id: locationId || null,
            ...(group.value ? { group_id: group.value } : {}),
            password_hash: null, is_active: true,
            invite_token: token, invite_expires_at: expires,
            invited_by: invitedBy, invited_by_type: invitedByType
        })
        .select('id, email, name, role, location_id')
        .single();
    if (error) throw error;

    const invite = await sendInvite({
        to: email, name,
        inviteUrl: `${baseUrl()}/set-password.html?token=${token}&kind=company&slug=${encodeURIComponent(company.slug)}`,
        context: company.name,
        expiresText: `${INVITE_TTL_DAYS} days`
    });

    return { status: 201, body: { message: `Invite sent to ${email}.`, user: created, email_sent: invite.sent } };
}

/** The public shape of a user row -- never the hash or invite token. */
function pickUser(u) {
    return { id: u.id, email: u.email, name: u.name, role: u.role, location_id: u.location_id, group_id: u.group_id || null, is_active: u.is_active };
}

async function updateUser({ company, userId, patch, actorUserId }) {
    if (!isValidUUID(userId)) return { status: 400, body: { error: 'Invalid user id.' } };

    const { data: user } = await supabaseAdmin
        .from('company_users').select('id, role').eq('id', userId).eq('company_id', company.id).maybeSingle();
    if (!user) return { status: 404, body: { error: 'User not found.' } };

    // Don't let an owner lock themselves out.
    if (userId === actorUserId && patch.is_active === false) {
        return { status: 400, body: { error: 'You cannot deactivate your own account.' } };
    }

    const update = { updated_at: new Date().toISOString() };
    if (patch.name !== undefined) update.name = stripHtml(patch.name).trim();
    if (patch.email !== undefined) {
        const email = stripHtml(patch.email).trim().toLowerCase();
        if (!validateEmail(email)) return { status: 400, body: { error: 'A valid email is required.' } };
        const { data: existing } = await supabaseAdmin
            .from('company_users').select('id').eq('company_id', company.id).ilike('email', email).neq('id', userId).maybeSingle();
        if (existing) return { status: 409, body: { error: 'A user with that email already exists for this company.' } };
        update.email = email;
    }
    if (patch.is_active !== undefined) update.is_active = patch.is_active === true;
    if (patch.role !== undefined) {
        if (!ROLES.includes(patch.role)) return { status: 400, body: { error: 'Invalid role.' } };
        update.role = patch.role;
    }
    if (patch.location_id !== undefined) {
        const loc = patch.location_id || null;
        if (loc) {
            if (!isValidUUID(loc)) return { status: 400, body: { error: 'Invalid location.' } };
            const { data: l } = await supabaseAdmin
                .from('company_locations').select('id').eq('id', loc).eq('company_id', company.id).maybeSingle();
            if (!l) return { status: 400, body: { error: 'That location is not part of this company.' } };
        }
        update.location_id = loc;
    }
    if (patch.group_id !== undefined) {
        const group = await resolveGroupId(company.id, patch.group_id);
        if (!group.ok) return { status: 400, body: { error: group.error } };
        update.group_id = group.value;
    }

    const { data, error } = await supabaseAdmin
        .from('company_users').update(update).eq('id', userId).eq('company_id', company.id)
        .select('*').single();
    if (error) throw error;
    return { status: 200, body: { message: 'Saved.', user: pickUser(data) } };
}

async function resendInvite({ company, userId }) {
    if (!isValidUUID(userId)) return { status: 400, body: { error: 'Invalid user id.' } };
    const { data: user } = await supabaseAdmin
        .from('company_users').select('id, email, name, password_hash').eq('id', userId).eq('company_id', company.id).maybeSingle();
    if (!user) return { status: 404, body: { error: 'User not found.' } };

    const { token, expires } = newInvite();
    await supabaseAdmin.from('company_users')
        .update({ invite_token: token, invite_expires_at: expires, updated_at: new Date().toISOString() })
        .eq('id', userId);

    const invite = await sendInvite({
        to: user.email, name: user.name,
        inviteUrl: `${baseUrl()}/set-password.html?token=${token}&kind=company&slug=${encodeURIComponent(company.slug)}`,
        context: company.name,
        expiresText: `${INVITE_TTL_DAYS} days`,
        reset: !!user.password_hash
    });
    return { status: 200, body: { message: `${user.password_hash ? 'Password-reset link' : 'Invite'} sent to ${user.email}.`, email_sent: invite.sent } };
}

/**
 * Self-service "forgot password" for a customer user.
 *
 * Says nothing about whether the address exists: the caller always gives the
 * same answer, so this cannot be used to find out who has an account. Sends a
 * reset link only to an active user of an active company that has individual
 * logins on, and at most once every RESET_COOLDOWN_MINUTES per user — the age
 * of the last link is read from its expiry, so no extra column is needed.
 *
 * @returns {{sent:boolean, reason?:string}}  (for tests and logs; never shown to the requester)
 */
const RESET_COOLDOWN_MINUTES = 10;
async function requestPasswordReset({ company, email }) {
    email = stripHtml(email || '').trim().toLowerCase();
    if (!company || !company.is_active) return { sent: false, reason: 'company_inactive' };
    if (company.settings?.users?.enabled !== true) return { sent: false, reason: 'users_off' };
    if (!validateEmail(email)) return { sent: false, reason: 'bad_email' };

    const { data: user } = await supabaseAdmin
        .from('company_users')
        .select('id, email, name, is_active, password_hash, invite_expires_at')
        .eq('company_id', company.id).ilike('email', email).maybeSingle();
    if (!user || !user.is_active) return { sent: false, reason: 'no_user' };

    if (user.invite_expires_at) {
        const issuedAt = new Date(user.invite_expires_at).getTime() - INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;
        if (Date.now() - issuedAt < RESET_COOLDOWN_MINUTES * 60 * 1000) return { sent: false, reason: 'cooldown' };
    }

    const { token, expires } = newInvite();
    await supabaseAdmin.from('company_users')
        .update({ invite_token: token, invite_expires_at: expires, updated_at: new Date().toISOString() })
        .eq('id', user.id);

    const mail = await sendInvite({
        to: user.email, name: user.name,
        inviteUrl: `${baseUrl()}/set-password.html?token=${token}&kind=company&slug=${encodeURIComponent(company.slug)}`,
        context: company.name,
        expiresText: `${INVITE_TTL_DAYS} days`,
        reset: !!user.password_hash
    });
    return { sent: !!mail.sent, reason: mail.sent ? undefined : 'email_failed' };
}

async function deactivateUser({ company, userId, actorUserId }) {
    if (!isValidUUID(userId)) return { status: 400, body: { error: 'Invalid user id.' } };
    if (userId === actorUserId) return { status: 400, body: { error: 'You cannot deactivate your own account.' } };
    const { error } = await supabaseAdmin
        .from('company_users').update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', userId).eq('company_id', company.id);
    if (error) throw error;
    return { status: 200, body: { message: 'User deactivated.' } };
}

/**
 * Permanently remove a customer user — only once already deactivated, so
 * nobody can skip the safer, reversible step by mistake. Unlike CHC staff
 * (admin_users), every foreign key onto company_users (an order's
 * placed_by_user_id, a shared-cart line's added_by_user_id) is already
 * ON DELETE SET NULL by design, so this never fails on referenced history —
 * it just unattributes those old records, which is the schema's own existing
 * trade-off, not a new one made here.
 */
async function purgeUser({ company, userId, actorUserId }) {
    if (!isValidUUID(userId)) return { status: 400, body: { error: 'Invalid user id.' } };
    if (userId === actorUserId) return { status: 400, body: { error: 'You cannot delete your own account.' } };

    const { data: user } = await supabaseAdmin
        .from('company_users').select('id, is_active').eq('id', userId).eq('company_id', company.id).maybeSingle();
    if (!user) return { status: 404, body: { error: 'User not found.' } };
    if (user.is_active) return { status: 400, body: { error: 'Deactivate this user before deleting them.' } };

    const { error } = await supabaseAdmin.from('company_users').delete().eq('id', userId).eq('company_id', company.id);
    if (error) throw error;
    return { status: 200, body: { message: 'User permanently deleted.' } };
}

module.exports = { ROLES, listUsers, createUser, updateUser, resendInvite, requestPasswordReset, deactivateUser, purgeUser };
