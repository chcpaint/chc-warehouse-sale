/**
 * utils/people-activity.js
 *
 * "Who is ordering, who is signing in" for one customer company: named groups
 * of people, a sign-in log, and the per-person report built from the orders
 * (each order carries who placed it -- see migration 045).
 *
 * Opt-in per company by the `activity` module (utils/modules.js). Nothing here
 * changes how anyone orders; it only records and reports.
 *
 * The aggregation (summarise) is a pure function of rows, so the numbers an
 * owner may act on -- "this person spent 3x the team average" -- are covered by
 * tests without a database.
 */

const { supabaseAdmin } = require('./supabase');
const { stripHtml, isValidUUID } = require('./sanitize');

const GROUP_NAME_MAX = 80;
const PAGE = 1000;                 // PostgREST returns at most 1000 rows a request
const MAX_PAGES = 30;              // 30,000 rows is far beyond any single customer
const SIGN_IN_EVENTS = new Set(['login', 'password_set', 'password_reset']);
// A person is flagged when they spent at least this multiple of the average
// ordering person's spend, and at least MIN_PEOPLE people ordered (with two
// people one of them is always "above average", which says nothing).
const HIGH_SPEND_MULTIPLE = 2;
const HIGH_SPEND_MIN_PEOPLE = 3;

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = n => Math.round(n * 100) / 100;

/** Fetch every row of a query a page at a time. `build(from, to)` returns the ranged query. */
async function fetchAll(build) {
    const rows = [];
    for (let page = 0; page < MAX_PAGES; page++) {
        const { data, error } = await build(page * PAGE, page * PAGE + PAGE - 1);
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < PAGE) break;
    }
    return rows;
}

function clientIp(req) {
    const v = (req && (req.ip || req.headers?.['x-forwarded-for'])) || '';
    return String(v).split(',')[0].trim().slice(0, 64) || null;
}

/**
 * Write one sign-in event. Never throws and never blocks a sign-in: a logging
 * problem must not stop a customer reaching their store.
 *
 * @param {{companyId:string, user?:{id,name,email}, email?:string, event:string, req?:object}} o
 *   event: login | failed | disabled | password_set | password_reset
 */
async function recordLogin({ companyId, user, email, event, req }) {
    try {
        if (!companyId) return;
        const { error } = await supabaseAdmin.from('company_user_logins').insert({
            company_id: companyId,
            user_id: user?.id || null,
            email: String(user?.email || email || '').slice(0, 255) || null,
            name: user?.name ? String(user.name).slice(0, 255) : null,
            event,
            ip: clientIp(req),
            user_agent: String(req?.headers?.['user-agent'] || '').slice(0, 300) || null
        });
        // Before migration 045 is applied the table does not exist; say so once
        // in the log rather than failing the request.
        if (error) console.error('[people-activity] login log skipped:', error.message || error.code);
    } catch (err) {
        console.error('[people-activity] login log failed:', err.message);
    }
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

function cleanGroupName(raw) {
    return stripHtml(raw || '').replace(/\s+/g, ' ').trim();
}

async function listGroups(companyId) {
    const [{ data: groups, error }, { data: members }] = await Promise.all([
        supabaseAdmin.from('company_user_groups').select('id, name, created_at')
            .eq('company_id', companyId).order('name', { ascending: true }),
        supabaseAdmin.from('company_users').select('id, group_id, is_active').eq('company_id', companyId)
    ]);
    if (error) throw error;
    const counts = new Map();
    for (const m of members || []) {
        if (!m.group_id || m.is_active === false) continue;
        counts.set(m.group_id, (counts.get(m.group_id) || 0) + 1);
    }
    return (groups || [])
        .map(g => ({ id: g.id, name: g.name, members: counts.get(g.id) || 0 }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

async function groupNameTaken(companyId, name, exceptId) {
    const { data } = await supabaseAdmin.from('company_user_groups').select('id, name').eq('company_id', companyId);
    const want = name.toLowerCase();
    return (data || []).some(g => g.id !== exceptId && String(g.name).toLowerCase() === want);
}

async function createGroup({ companyId, name }) {
    name = cleanGroupName(name);
    if (!name) return { status: 400, body: { error: 'Give the group a name.' } };
    if (name.length > GROUP_NAME_MAX) return { status: 400, body: { error: `Keep the group name under ${GROUP_NAME_MAX} characters.` } };
    if (await groupNameTaken(companyId, name)) return { status: 409, body: { error: `There is already a group called "${name}".` } };

    const { data, error } = await supabaseAdmin.from('company_user_groups')
        .insert({ company_id: companyId, name }).select('id, name').single();
    if (error) throw error;
    return { status: 201, body: { message: `Group "${name}" created.`, group: { ...data, members: 0 } } };
}

async function renameGroup({ companyId, groupId, name }) {
    if (!isValidUUID(groupId)) return { status: 400, body: { error: 'Invalid group.' } };
    name = cleanGroupName(name);
    if (!name) return { status: 400, body: { error: 'Give the group a name.' } };
    if (name.length > GROUP_NAME_MAX) return { status: 400, body: { error: `Keep the group name under ${GROUP_NAME_MAX} characters.` } };

    const { data: group } = await supabaseAdmin.from('company_user_groups')
        .select('id').eq('id', groupId).eq('company_id', companyId).maybeSingle();
    if (!group) return { status: 404, body: { error: 'Group not found.' } };
    if (await groupNameTaken(companyId, name, groupId)) return { status: 409, body: { error: `There is already a group called "${name}".` } };

    const { data, error } = await supabaseAdmin.from('company_user_groups')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', groupId).eq('company_id', companyId).select('id, name').single();
    if (error) throw error;
    return { status: 200, body: { message: 'Saved.', group: data } };
}

/** Delete a group. Its people stay, just ungrouped; past orders keep the group name they were placed under. */
async function deleteGroup({ companyId, groupId }) {
    if (!isValidUUID(groupId)) return { status: 400, body: { error: 'Invalid group.' } };
    const { data: group } = await supabaseAdmin.from('company_user_groups')
        .select('id, name').eq('id', groupId).eq('company_id', companyId).maybeSingle();
    if (!group) return { status: 404, body: { error: 'Group not found.' } };

    // Explicit rather than relying on ON DELETE SET NULL alone, so the people are
    // ungrouped even on a database where the constraint was changed.
    await supabaseAdmin.from('company_users').update({ group_id: null }).eq('company_id', companyId).eq('group_id', groupId);
    const { error } = await supabaseAdmin.from('company_user_groups').delete().eq('id', groupId).eq('company_id', companyId);
    if (error) throw error;
    return { status: 200, body: { message: `Group "${group.name}" deleted. Its people are now ungrouped.` } };
}

/** A group id that must belong to this company, or null to clear. Returns {ok, value|error}. */
async function resolveGroupId(companyId, groupId) {
    if (groupId === null || groupId === undefined || groupId === '') return { ok: true, value: null };
    if (!isValidUUID(groupId)) return { ok: false, error: 'Invalid group.' };
    const { data } = await supabaseAdmin.from('company_user_groups')
        .select('id').eq('id', groupId).eq('company_id', companyId).maybeSingle();
    if (!data) return { ok: false, error: 'That group is not part of this company.' };
    return { ok: true, value: groupId };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

function unitsOf(order) {
    const items = Array.isArray(order.items) ? order.items : [];
    return items.reduce((s, i) => s + num(i.quantity), 0);
}

/**
 * Turn rows into the report. Pure.
 *
 * @param {Object} o
 * @param {Array}  o.orders   orders in the period (any status)
 * @param {Array}  o.users    every company_users row, with group_name and location_name resolved
 * @param {Array}  o.logins   company_user_logins rows in the period
 * @param {boolean} o.hidePricing  blank every dollar figure (customer-side, packing-slip mode)
 */
function summarise({ orders = [], users = [], logins = [], hidePricing = false }) {
    const money = n => (hidePricing ? null : round2(n));
    const byId = new Map(users.map(u => [u.id, u]));

    const people = new Map();
    const personFor = (key, seed) => {
        if (!people.has(key)) {
            people.set(key, {
                key, user_id: seed.user_id || null, name: seed.name, email: seed.email || null,
                group: seed.group || null, location: seed.location || null,
                is_active: seed.is_active, status: seed.status,
                role: seed.role || null,
                orders: 0, units: 0, spend: 0, largest: 0, last_order_at: null,
                last_login: seed.last_login || null, logins: 0, failed_logins: 0
            });
        }
        return people.get(key);
    };

    // Everyone who can sign in appears, even with no orders -- "who is not
    // ordering" is part of the picture.
    for (const u of users) {
        personFor(u.id, {
            user_id: u.id, name: u.name, email: u.email, group: u.group_name || null,
            location: u.location_name || null, is_active: u.is_active !== false, role: u.role,
            status: !u.password_hash ? 'invited' : (u.is_active === false ? 'disabled' : 'active'),
            last_login: u.last_login
        });
    }

    let cancelled = 0;
    const sharedBucket = { orders: 0, units: 0, spend: 0 };

    for (const o of orders) {
        if (o.status === 'cancelled') { cancelled++; continue; }
        const total = num(o.total);
        const units = unitsOf(o);

        let person = null;
        if (o.placed_by_user_id && byId.has(o.placed_by_user_id)) {
            person = people.get(o.placed_by_user_id);
        } else if (o.placed_by_name || o.placed_by_user_id) {
            // The account is gone (deleted) but the order remembers who it was.
            const label = o.placed_by_name || 'Former user';
            person = personFor(`former:${String(o.placed_by_email || label).toLowerCase()}`, {
                name: label, email: o.placed_by_email, group: o.placed_by_group,
                is_active: false, status: 'removed'
            });
        }

        if (!person) {
            // A shared access-code order: nobody to attribute it to.
            sharedBucket.orders++; sharedBucket.units += units; sharedBucket.spend += total;
            continue;
        }
        person.orders++; person.units += units; person.spend += total;
        if (total > person.largest) person.largest = total;
        if (!person.last_order_at || o.created_at > person.last_order_at) person.last_order_at = o.created_at;
    }

    let signedIn = new Set(), loginCount = 0, failedCount = 0, sharedRefused = 0;
    for (const l of logins) {
        const person = l.user_id ? people.get(l.user_id) : null;
        if (SIGN_IN_EVENTS.has(l.event)) {
            loginCount++;
            if (l.user_id) signedIn.add(l.user_id);
            if (person) person.logins++;
        } else if (l.event === 'failed' || l.event === 'disabled') {
            failedCount++;
            if (person) person.failed_logins++;
        } else if (l.event === 'shared_refused') {
            sharedRefused++;
        }
    }

    const list = [...people.values()];
    const ordering = list.filter(p => p.orders > 0);
    const totalSpend = list.reduce((s, p) => s + p.spend, 0) + sharedBucket.spend;
    const attributedSpend = list.reduce((s, p) => s + p.spend, 0);
    const avgPerOrderingPerson = ordering.length ? attributedSpend / ordering.length : 0;
    const flagOn = !hidePricing && ordering.length >= HIGH_SPEND_MIN_PEOPLE;

    const peopleOut = list.map(p => ({
        key: p.key, user_id: p.user_id, name: p.name, email: p.email, role: p.role,
        group: p.group, location: p.location, status: p.status, is_active: p.is_active,
        orders: p.orders, units: p.units,
        spend: money(p.spend),
        avg_order: p.orders ? money(p.spend / p.orders) : (hidePricing ? null : 0),
        largest_order: money(p.largest),
        share: hidePricing || !totalSpend ? null : Math.round((p.spend / totalSpend) * 1000) / 10,
        last_order_at: p.last_order_at,
        last_login: p.last_login, logins: p.logins, failed_logins: p.failed_logins,
        flag: flagOn && p.spend > 0 && p.spend >= HIGH_SPEND_MULTIPLE * avgPerOrderingPerson ? 'high_spend' : null
    })).sort((a, b) =>
        (num(b.spend) - num(a.spend)) || (b.orders - a.orders) || String(a.name).localeCompare(String(b.name)));

    // Groups: by the person's group as it is now (as it was, for removed people).
    const groups = new Map();
    for (const p of peopleOut) {
        const g = p.group || null;
        if (!groups.has(g)) groups.set(g, { name: g, members: 0, ordering: 0, orders: 0, units: 0, spend: 0 });
        const row = groups.get(g);
        if (p.status !== 'removed' && p.is_active) row.members++;
        if (p.orders > 0) row.ordering++;
        row.orders += p.orders; row.units += p.units; row.spend += num(p.spend);
    }
    const groupsOut = [...groups.values()].map(g => ({
        name: g.name, members: g.members, ordering: g.ordering, orders: g.orders, units: g.units,
        spend: money(g.spend),
        avg_order: g.orders ? money(g.spend / g.orders) : (hidePricing ? null : 0),
        spend_per_member: g.members ? money(g.spend / g.members) : (hidePricing ? null : 0),
        share: hidePricing || !totalSpend ? null : Math.round((g.spend / totalSpend) * 1000) / 10
    })).sort((a, b) => (num(b.spend) - num(a.spend)) || (b.orders - a.orders)
        || String(a.name || '~').localeCompare(String(b.name || '~')));

    const orderCount = list.reduce((s, p) => s + p.orders, 0) + sharedBucket.orders;
    return {
        summary: {
            orders: orderCount,
            units: list.reduce((s, p) => s + p.units, 0) + sharedBucket.units,
            spend: money(totalSpend),
            avg_order: orderCount ? money(totalSpend / orderCount) : (hidePricing ? null : 0),
            people_ordering: ordering.length,
            people_signed_in: signedIn.size,
            logins: loginCount,
            failed_logins: failedCount,
            shared_code_attempts: sharedRefused,
            cancelled_orders: cancelled,
            shared_login_orders: sharedBucket.orders,
            shared_login_spend: money(sharedBucket.spend),
            avg_per_ordering_person: hidePricing ? null : round2(avgPerOrderingPerson),
            high_spend_rule: hidePricing ? null
                : `A person is flagged when they spend at least ${HIGH_SPEND_MULTIPLE}x the average ordering person (needs ${HIGH_SPEND_MIN_PEOPLE}+ people ordering).`
        },
        people: peopleOut,
        groups: groupsOut
    };
}

async function loadUsers(companyId) {
    const { data, error } = await supabaseAdmin.from('company_users')
        .select('id, email, name, role, location_id, group_id, is_active, last_login, password_hash, company_locations:location_id (id, name), company_user_groups:group_id (id, name)')
        .eq('company_id', companyId);
    if (error) throw error;
    return (data || []).map(u => ({
        id: u.id, email: u.email, name: u.name, role: u.role, is_active: u.is_active,
        last_login: u.last_login, password_hash: u.password_hash,
        location_id: u.location_id, location_name: u.company_locations?.name || null,
        group_id: u.group_id, group_name: u.company_user_groups?.name || null
    }));
}

const ORDER_COLUMNS = 'id, order_number, created_at, total, status, location, location_id, po_number, items, placed_by_user_id, placed_by_name, placed_by_email, placed_by_group, contact_name';

async function loadOrders({ companyId, from, to, locationId }) {
    return fetchAll((a, b) => {
        let q = supabaseAdmin.from('orders').select(ORDER_COLUMNS).eq('company_id', companyId);
        if (locationId) q = q.eq('location_id', locationId);
        if (from) q = q.gte('created_at', from);
        if (to) q = q.lte('created_at', to);
        return q.order('created_at', { ascending: false }).range(a, b);
    });
}

async function loadLogins({ companyId, from, to, userId, limit }) {
    const build = (a, b) => {
        let q = supabaseAdmin.from('company_user_logins')
            .select('id, user_id, email, name, event, ip, user_agent, created_at').eq('company_id', companyId);
        if (userId) q = q.eq('user_id', userId);
        if (from) q = q.gte('created_at', from);
        if (to) q = q.lte('created_at', to);
        return q.order('created_at', { ascending: false }).range(a, b);
    };
    if (limit) {
        const { data, error } = await build(0, Math.min(limit, PAGE) - 1);
        if (error) throw error;
        return data || [];
    }
    return fetchAll(build);
}

function validDate(v) {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The whole report for a company and period. */
async function loadActivity({ companyId, from, to, locationId, groupId, hidePricing }) {
    const f = validDate(from), t = validDate(to);
    const loc = locationId && isValidUUID(locationId) ? locationId : null;
    const [orders, users, logins] = await Promise.all([
        loadOrders({ companyId, from: f, to: t, locationId: loc }),
        loadUsers(companyId),
        loadLogins({ companyId, from: f, to: t })
    ]);

    let scopedUsers = users;
    let scopedOrders = orders, scopedLogins = logins;
    if (groupId && isValidUUID(groupId)) {
        scopedUsers = users.filter(u => u.group_id === groupId);
        const ids = new Set(scopedUsers.map(u => u.id));
        scopedOrders = orders.filter(o => o.placed_by_user_id && ids.has(o.placed_by_user_id));
        scopedLogins = logins.filter(l => l.user_id && ids.has(l.user_id));
    }
    if (loc) {
        // Orders are already limited to this shop; a person belongs to a shop only if tied to it.
        scopedUsers = scopedUsers.filter(u => !u.location_id || u.location_id === loc
            || scopedOrders.some(o => o.placed_by_user_id === u.id));
    }

    const report = summarise({ orders: scopedOrders, users: scopedUsers, logins: scopedLogins, hidePricing });
    return { ...report, period: { from: f, to: t } };
}

/** One person: their orders and their sign-ins in the period. */
async function loadPersonActivity({ companyId, userId, from, to, hidePricing, orderLimit = 200, loginLimit = 100 }) {
    if (!isValidUUID(userId)) return { status: 400, body: { error: 'Invalid user.' } };
    const f = validDate(from), t = validDate(to);

    const { data: user } = await supabaseAdmin.from('company_users')
        .select('id, name, email, group_id, last_login').eq('id', userId).eq('company_id', companyId).maybeSingle();
    if (!user) return { status: 404, body: { error: 'User not found.' } };

    const orders = (await fetchAll((a, b) => {
        let q = supabaseAdmin.from('orders').select(ORDER_COLUMNS)
            .eq('company_id', companyId).eq('placed_by_user_id', userId);
        if (f) q = q.gte('created_at', f);
        if (t) q = q.lte('created_at', t);
        return q.order('created_at', { ascending: false }).range(a, b);
    })).slice(0, orderLimit);
    const logins = await loadLogins({ companyId, from: f, to: t, userId, limit: loginLimit });

    return {
        status: 200,
        body: {
            user: { id: user.id, name: user.name, email: user.email, last_login: user.last_login },
            orders: orders.map(o => ({
                id: o.id, order_number: o.order_number, created_at: o.created_at, status: o.status,
                location: o.location, po_number: o.po_number, units: unitsOf(o),
                total: hidePricing ? null : round2(num(o.total))
            })),
            logins: logins.map(l => ({ id: l.id, event: l.event, ip: l.ip, user_agent: l.user_agent, created_at: l.created_at }))
        }
    };
}

/** The company-wide sign-in feed, newest first. */
async function loadLoginFeed({ companyId, from, to, userId, limit = 200 }) {
    const rows = await loadLogins({
        companyId, from: validDate(from), to: validDate(to),
        userId: userId && isValidUUID(userId) ? userId : null,
        limit: Math.max(1, Math.min(Number(limit) || 200, PAGE))
    });
    return rows.map(l => ({
        id: l.id, user_id: l.user_id, name: l.name, email: l.email, event: l.event,
        ip: l.ip, user_agent: l.user_agent, created_at: l.created_at
    }));
}

/**
 * The signed-in user behind an order, as it must be recorded. Reloaded from
 * the database rather than trusted from the 24-hour token, so a person who was
 * deactivated (or moved to another group) is stopped / recorded correctly
 * straight away.
 *
 * @returns {Promise<{ok:true,user:object}|{ok:false,status:number,error:string}>}
 */
async function resolveOrderingUser(companyId, tokenUser) {
    if (!tokenUser || !tokenUser.id) return { ok: false, status: 401, error: 'Please sign in again.' };
    // Group columns arrive with migration 045; without them, still resolve the
    // person (just with no group) rather than refusing their order.
    let { data: user, error } = await supabaseAdmin.from('company_users')
        .select('id, name, email, role, is_active, group_id, company_user_groups:group_id (name)')
        .eq('id', tokenUser.id).eq('company_id', companyId).maybeSingle();
    if (error) {
        ({ data: user } = await supabaseAdmin.from('company_users')
            .select('id, name, email, role, is_active')
            .eq('id', tokenUser.id).eq('company_id', companyId).maybeSingle());
    }
    if (!user || user.is_active === false) {
        return { ok: false, status: 401, error: 'This account is no longer active. Please contact your account owner.' };
    }
    return {
        ok: true,
        user: { id: user.id, name: user.name, email: user.email, role: user.role, group_id: user.group_id || null, group_name: user.company_user_groups?.name || null }
    };
}

module.exports = {
    HIGH_SPEND_MULTIPLE, HIGH_SPEND_MIN_PEOPLE,
    recordLogin, clientIp,
    listGroups, createGroup, renameGroup, deleteGroup, resolveGroupId,
    summarise, loadActivity, loadPersonActivity, loadLoginFeed, resolveOrderingUser, validDate
};
