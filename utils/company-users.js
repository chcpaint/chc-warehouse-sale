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
    const { data } = await supabaseAdmin
        .from('company_users')
        .select('id, email, name, role, location_id, is_active, last_login, password_hash, company_locations:location_id (id, name)')
        .eq('company_id', companyId)
        .order('created_at', { ascending: true });

    return (data || []).map(u => ({
        id: u.id, email: u.email, name: u.name, role: u.role,
        location_id: u.location_id,
        location_name: u.company_locations?.name || null,
        is_active: u.is_active, last_login: u.last_login,
        status: u.password_hash ? (u.is_active ? 'active' : 'disabled') : 'invited'
    }));
}

/**
 * Create a customer user and send them a set-password invite.
 * @returns {{status:number, body:object}}
 */
async function createUser({ company, name, email, locationId, role, invitedBy, invitedByType }) {
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

    const { data: existing } = await supabaseAdmin
        .from('company_users').select('id').eq('company_id', company.id).ilike('email', email).maybeSingle();
    if (existing) return { status: 409, body: { error: 'A user with that email already exists for this company.' } };

    const { token, expires } = newInvite();
    const { data: created, error } = await supabaseAdmin
        .from('company_users')
        .insert({
            company_id: company.id, email, name, role,
            location_id: locationId || null,
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

    const { data, error } = await supabaseAdmin
        .from('company_users').update(update).eq('id', userId).eq('company_id', company.id)
        .select('id, email, name, role, location_id, is_active').single();
    if (error) throw error;
    return { status: 200, body: { message: 'Saved.', user: data } };
}

async function resendInvite({ company, userId }) {
    if (!isValidUUID(userId)) return { status: 400, body: { error: 'Invalid user id.' } };
    const { data: user } = await supabaseAdmin
        .from('company_users').select('id, email, name').eq('id', userId).eq('company_id', company.id).maybeSingle();
    if (!user) return { status: 404, body: { error: 'User not found.' } };

    const { token, expires } = newInvite();
    await supabaseAdmin.from('company_users')
        .update({ invite_token: token, invite_expires_at: expires, updated_at: new Date().toISOString() })
        .eq('id', userId);

    const invite = await sendInvite({
        to: user.email, name: user.name,
        inviteUrl: `${baseUrl()}/set-password.html?token=${token}&kind=company&slug=${encodeURIComponent(company.slug)}`,
        context: company.name,
        expiresText: `${INVITE_TTL_DAYS} days`
    });
    return { status: 200, body: { message: `Invite re-sent to ${user.email}.`, email_sent: invite.sent } };
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

module.exports = { ROLES, listUsers, createUser, updateUser, resendInvite, deactivateUser };
