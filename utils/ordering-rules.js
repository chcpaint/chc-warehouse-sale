/**
 * utils/ordering-rules.js
 *
 * Optional ordering rules (migration 071). Four rules, each off until someone
 * turns it on, set once for the company and overridable per shop:
 *
 *   order_limit    an order over $X before tax needs a manager
 *   stock_ceiling  shelf stock + stock on the way + this order over $X needs a manager
 *   hold           orders are on hold: staff can build them, a manager releases them
 *   staff_items    items marked "needs approval" need a manager
 *
 * A manager approves with a named approval passcode (or is an owner signed in
 * with their own login). Who can approve is decided here, on the server, for
 * every path that creates an order: the store, the kiosk, a replenishment.
 * Hiding a button in the browser is never the rule.
 *
 * The pure parts (effectiveRules, evaluate, normalizeRulesPatch) take no
 * database and are unit-tested directly. The rest reads and writes the four
 * tables, and reads every one of them defensively: before 071 is applied the
 * tables are missing, and ordering must carry on exactly as before.
 */

const crypto = require('crypto');
const { supabaseAdmin } = require('./supabase');
const { passcodeProblem, hashPasscode, verifyPasscode, PASSCODE_MIN, PASSCODE_MAX } = require('./scan-out');

const RULE_KEYS = ['order_limit', 'stock_ceiling', 'hold', 'staff_items'];
const ROW_COLUMNS = 'id, company_id, location_id, order_limit_on, order_limit, stock_ceiling_on, stock_ceiling, hold_on, hold_message, staff_items_on, updated_at, updated_by';
const DEFAULT_HOLD_MESSAGE = 'Orders are on hold. A manager needs to approve this order before it goes to CHC.';

// Five wrong passcodes lock that shop's approvals for five minutes.
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;

const money = (n) => '$' + (Math.round(Number(n || 0) * 100) / 100)
    .toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/** A table that 071 adds is missing: carry on as if every rule is off. */
function missingTable(err) {
    return !!err && (err.code === '42P01' || err.code === 'PGRST205' || err.code === '42703' ||
        /ordering_rules|approval_passcodes|approval_lockouts|order_approvals|requires_approval|relation .* does not exist|schema cache/i
            .test(err.message || ''));
}

// ----------------------------------------------------------------------------
// PURE
// ----------------------------------------------------------------------------

/**
 * What applies to one shop: its own setting where it has one, otherwise the
 * company's, otherwise off. A rule with no amount is treated as off, because
 * "approval over $nothing" would stop every order and nobody means that.
 */
function effectiveRules(companyRow, locationRow) {
    const pick = (key) => {
        const own = locationRow && locationRow[key];
        if (own !== null && own !== undefined) return own;
        const co = companyRow && companyRow[key];
        return co === undefined ? null : co;
    };
    const amount = (key) => { const v = pick(key); return v === null || v === '' ? null : round2(v); };

    const limit = amount('order_limit');
    const ceiling = amount('stock_ceiling');
    const msg = String(pick('hold_message') || '').trim();
    return {
        order_limit: { on: pick('order_limit_on') === true && limit !== null, amount: limit },
        stock_ceiling: { on: pick('stock_ceiling_on') === true && ceiling !== null, amount: ceiling },
        hold: { on: pick('hold_on') === true, message: msg || DEFAULT_HOLD_MESSAGE },
        staff_items: { on: pick('staff_items_on') === true }
    };
}

function anyOn(rules) {
    return !!rules && RULE_KEYS.some(k => rules[k] && rules[k].on);
}

/**
 * Why this order needs a manager. An empty list means it does not.
 *
 *   subtotal  priced lines before tax and fees (price-on-request lines have no price yet)
 *   lines     [{ name, quantity, requires_approval }]
 *   stock     { on_shelf, on_the_way } when the stock ceiling is on
 */
function evaluate({ rules, subtotal, lines = [], stock = null }) {
    const reasons = [];
    if (!rules) return reasons;
    const sub = round2(subtotal);

    if (rules.hold.on) {
        reasons.push({ code: 'hold', title: 'Orders are on hold', detail: rules.hold.message });
    }

    if (rules.order_limit.on && sub > rules.order_limit.amount) {
        reasons.push({
            code: 'order_limit',
            title: `Over the ${money(rules.order_limit.amount)} order limit`,
            detail: `This order is ${money(sub)} before tax. Orders over ${money(rules.order_limit.amount)} need a manager.`,
            amount: sub, limit: rules.order_limit.amount
        });
    }

    if (rules.stock_ceiling.on && stock) {
        const shelf = round2(stock.on_shelf), way = round2(stock.on_the_way);
        const after = round2(shelf + way + sub);
        if (after > rules.stock_ceiling.amount) {
            reasons.push({
                code: 'stock_ceiling',
                title: `Over the ${money(rules.stock_ceiling.amount)} stock limit`,
                detail: `On the shelf ${money(shelf)} + on the way ${money(way)} + this order ${money(sub)} = ${money(after)}. ` +
                    `This shop keeps stock at or under ${money(rules.stock_ceiling.amount)}.`,
                on_shelf: shelf, on_the_way: way, after, limit: rules.stock_ceiling.amount
            });
        }
    }

    if (rules.staff_items.on) {
        const locked = lines.filter(l => l && l.requires_approval);
        if (locked.length) {
            const names = locked.slice(0, 5).map(l => `${l.name} ×${l.quantity}`).join(', ');
            reasons.push({
                code: 'staff_items',
                title: locked.length === 1 ? '1 item needs a manager' : `${locked.length} items need a manager`,
                detail: names + (locked.length > 5 ? ` and ${locked.length - 5} more` : ''),
                items: locked.map(l => l.product_id).filter(Boolean)
            });
        }
    }
    return reasons;
}

/**
 * Validate a rules change from a screen. `forLocation` allows null for every
 * field ("same as the company"); the company row stores plain on/off.
 * Returns { ok, patch } or { ok: false, error }.
 */
function normalizeRulesPatch(body, { forLocation = false } = {}) {
    const b = body || {};
    const patch = {};

    const flag = (key) => {
        if (!(key in b)) return;
        const v = b[key];
        if (v === null || v === 'inherit') { patch[key] = forLocation ? null : false; return; }
        patch[key] = v === true || v === 'true' || v === 'on';
    };
    const amount = (key, label) => {
        if (!(key in b)) return null;
        const v = b[key];
        if (v === null || v === '') { patch[key] = null; return null; }
        const n = Number(String(v).replace(/[$,\s]/g, ''));
        if (!Number.isFinite(n) || n < 0) return `${label} must be a dollar amount of zero or more.`;
        if (n > 100000000) return `${label} is too large.`;
        patch[key] = round2(n);
        return null;
    };

    flag('order_limit_on'); flag('stock_ceiling_on'); flag('hold_on'); flag('staff_items_on');
    const e1 = amount('order_limit', 'The order limit');
    if (e1) return { ok: false, error: e1 };
    const e2 = amount('stock_ceiling', 'The stock limit');
    if (e2) return { ok: false, error: e2 };

    if ('hold_message' in b) {
        const m = String(b.hold_message === null || b.hold_message === undefined ? '' : b.hold_message)
            .replace(/<[^>]*>/g, '').trim().slice(0, 300);
        patch.hold_message = m || null;
    }

    // Turning a dollar rule on with no dollar amount would do nothing; say so
    // instead of saving a switch that looks on and is not.
    if (patch.order_limit_on === true && ('order_limit' in patch) && patch.order_limit === null) {
        return { ok: false, error: 'Enter the order limit in dollars to turn that rule on.' };
    }
    if (patch.stock_ceiling_on === true && ('stock_ceiling' in patch) && patch.stock_ceiling === null) {
        return { ok: false, error: 'Enter the stock limit in dollars to turn that rule on.' };
    }
    return { ok: true, patch };
}

/** A passcode name a person typed. */
function cleanName(v) {
    return String(v === undefined || v === null ? '' : v).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

// ----------------------------------------------------------------------------
// RULES
// ----------------------------------------------------------------------------

/** Every rules row for a company (company default first). [] before 071. */
async function loadRuleRows(companyId) {
    const { data, error } = await supabaseAdmin
        .from('ordering_rules').select(ROW_COLUMNS).eq('company_id', companyId);
    if (error) {
        if (missingTable(error)) return [];
        throw error;
    }
    return (data || []).sort((a, b) => (a.location_id ? 1 : 0) - (b.location_id ? 1 : 0));
}

/** The rules that apply to one shop. */
async function rulesFor(companyId, locationId) {
    const rows = await loadRuleRows(companyId);
    const companyRow = rows.find(r => !r.location_id) || null;
    const locationRow = locationId ? rows.find(r => r.location_id === locationId) || null : null;
    return { companyRow, locationRow, rules: effectiveRules(companyRow, locationRow) };
}

/** Save the company default (locationId null) or one shop's overrides. */
async function saveRules(companyId, locationId, patch, actor) {
    const rows = await loadRuleRows(companyId);
    const existing = rows.find(r => (r.location_id || null) === (locationId || null));
    const now = new Date().toISOString();
    if (existing) {
        const { data, error } = await supabaseAdmin.from('ordering_rules')
            .update({ ...patch, updated_at: now, updated_by: actor || null })
            .eq('id', existing.id).select(ROW_COLUMNS).single();
        if (error) throw error;
        return data;
    }
    const { data, error } = await supabaseAdmin.from('ordering_rules')
        .insert({ company_id: companyId, location_id: locationId || null, ...patch, updated_at: now, updated_by: actor || null })
        .select(ROW_COLUMNS).single();
    if (error) throw error;
    return data;
}

// ----------------------------------------------------------------------------
// STOCK POSITION (for the stock ceiling)
// ----------------------------------------------------------------------------

/**
 * What a shop holds and has coming, in dollars.
 *
 *   on_shelf    the refinishAI Inventory value of what is on the shelf now
 *               (zero for a shop that does not use inventory)
 *   on_the_way  orders already sent and not closed or cancelled, less what
 *               has already been received against them (that is on the shelf)
 *
 * Price-on-request lines cannot be valued; they are counted in `unvalued` so
 * a screen can say the figure is a floor.
 */
async function stockPosition(companyId, locationId) {
    let onShelf = 0, unvalued = 0;
    try {
        const { data } = await supabaseAdmin
            .from('inventory_status')
            .select('on_hand, price, price_on_request, line_value, stock_status')
            .eq('company_id', companyId).eq('location_id', locationId);
        for (const r of data || []) {
            if (r.stock_status === 'untracked' && !(Number(r.on_hand) > 0)) continue;
            if (r.price_on_request) { if (Number(r.on_hand || 0) > 0) unvalued++; continue; }
            const v = r.line_value !== undefined && r.line_value !== null
                ? Number(r.line_value) : Number(r.on_hand || 0) * Number(r.price || 0);
            if (v > 0) onShelf += v;
        }
    } catch (_) { /* no inventory: nothing on the shelf to count */ }

    let onTheWay = 0;
    try {
        const since = new Date(Date.now() - 180 * 864e5).toISOString();
        const { data: open } = await supabaseAdmin
            .from('orders').select('id, items, status, created_at')
            .eq('company_id', companyId).eq('location_id', locationId)
            .in('status', ['pending', 'processing', 'out_on_delivery'])
            .gte('created_at', since);
        const orders = open || [];
        let received = [];
        if (orders.length) {
            const { data: rec } = await supabaseAdmin
                .from('order_receipts').select('order_id, product_id, quantity_received')
                .in('order_id', orders.map(o => o.id));
            received = rec || [];
        }
        for (const o of orders) {
            const got = {};
            for (const r of received) {
                if (r.order_id === o.id && r.product_id) got[r.product_id] = (got[r.product_id] || 0) + Number(r.quantity_received || 0);
            }
            for (const line of Array.isArray(o.items) ? o.items : []) {
                if (line.price_on_request || line.unit_price === null || line.unit_price === undefined) continue;
                const left = Math.max(0, Number(line.quantity || 0) - (got[line.product_id] || 0));
                onTheWay += left * Number(line.unit_price || 0);
            }
        }
    } catch (_) { /* receipts table missing: count nothing on the way rather than guess */ }

    return { on_shelf: round2(onShelf), on_the_way: round2(onTheWay), unvalued };
}

/** Mark each priced line with whether its product needs a manager. */
async function markLockedLines(companyId, lines) {
    const ids = [...new Set((lines || []).map(l => l.product_id).filter(Boolean))];
    if (!ids.length) return lines;
    try {
        const { data, error } = await supabaseAdmin
            .from('products').select('id, requires_approval').eq('company_id', companyId).in('id', ids);
        if (error) return lines;
        const locked = new Set((data || []).filter(p => p.requires_approval === true).map(p => p.id));
        return lines.map(l => ({ ...l, requires_approval: locked.has(l.product_id) }));
    } catch (_) { return lines; }
}

/**
 * The whole check for one order at one shop: which rules apply and which
 * reasons this order trips. `lines` are the priced order lines.
 */
async function checkOrder(companyId, locationId, { subtotal, lines }) {
    const { rules } = await rulesFor(companyId, locationId);
    if (!anyOn(rules)) return { rules, reasons: [], stock: null };
    const stock = rules.stock_ceiling.on ? await stockPosition(companyId, locationId) : null;
    const marked = rules.staff_items.on ? await markLockedLines(companyId, lines) : lines;
    return { rules, stock, reasons: evaluate({ rules, subtotal, lines: marked, stock }) };
}

// ----------------------------------------------------------------------------
// PASSCODES
// ----------------------------------------------------------------------------

/** The passcodes that can approve at this shop (company-wide ones and the shop's own). */
async function activePasscodes(companyId, locationId) {
    const { data, error } = await supabaseAdmin
        .from('approval_passcodes')
        .select('id, company_id, location_id, name, passcode_hash, is_active, last_used_at, use_count')
        .eq('company_id', companyId).eq('is_active', true);
    if (error) {
        if (missingTable(error)) return [];
        throw error;
    }
    return (data || []).filter(p => !p.location_id || !locationId || p.location_id === locationId);
}

async function lockState(companyId, scopeKey) {
    try {
        const { data } = await supabaseAdmin.from('approval_lockouts')
            .select('fail_count, locked_until').eq('company_id', companyId).eq('scope_key', scopeKey).maybeSingle();
        const until = data && data.locked_until ? new Date(data.locked_until).getTime() : 0;
        return { exists: !!data, fails: Number(data && data.fail_count || 0), lockedMs: Math.max(0, until - Date.now()) };
    } catch (_) { return { exists: false, fails: 0, lockedMs: 0 }; }
}

async function writeLock(companyId, scopeKey, exists, fields) {
    try {
        const row = { ...fields, updated_at: new Date().toISOString() };
        if (exists) {
            await supabaseAdmin.from('approval_lockouts').update(row).eq('company_id', companyId).eq('scope_key', scopeKey);
        } else {
            await supabaseAdmin.from('approval_lockouts').insert({ company_id: companyId, scope_key: scopeKey, ...row });
        }
    } catch (_) { /* a lockout that cannot be written must not stop a right passcode working */ }
}

/**
 * Check a passcode typed at a shop. Wrong tries count against that shop.
 *
 * Returns { ok: true, passcode: { id, name, location_id } } or
 *         { ok: false, status, error, attempts_left?, locked_seconds? }
 */
async function verifyApprovalPasscode(companyId, locationId, raw) {
    const code = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!/^\d{1,12}$/.test(code)) return { ok: false, status: 400, error: 'Enter the approval passcode using numbers.' };

    const scopeKey = locationId || 'company';
    const lock = await lockState(companyId, scopeKey);
    if (lock.lockedMs > 0) {
        const mins = Math.max(1, Math.ceil(lock.lockedMs / 60000));
        return { ok: false, status: 429, error: `Too many wrong passcodes. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
            locked_seconds: Math.ceil(lock.lockedMs / 1000) };
    }

    const candidates = await activePasscodes(companyId, locationId);
    if (!candidates.length) {
        return { ok: false, status: 403, error: 'No approval passcode is set up for this shop yet. Ask CHC to add one.', no_passcodes: true };
    }

    let match = null;
    for (const p of candidates) {
        // Every candidate is checked, so the time taken does not say which one was close.
        if (await verifyPasscode(code, p.passcode_hash) && !match) match = p;
    }

    if (!match) {
        const fails = lock.fails + 1;
        const locking = fails >= MAX_FAILS;
        await writeLock(companyId, scopeKey, lock.exists, {
            fail_count: locking ? 0 : fails,
            locked_until: locking ? new Date(Date.now() + LOCK_MS).toISOString() : null
        });
        if (locking) {
            return { ok: false, status: 429, error: 'Too many wrong passcodes. Try again in 5 minutes.', locked_seconds: LOCK_MS / 1000 };
        }
        return { ok: false, status: 401, error: 'That approval passcode is not right.', attempts_left: MAX_FAILS - fails };
    }

    if (lock.fails) await writeLock(companyId, scopeKey, true, { fail_count: 0, locked_until: null });
    try {
        await supabaseAdmin.from('approval_passcodes')
            .update({ last_used_at: new Date().toISOString(), use_count: Number(match.use_count || 0) + 1 })
            .eq('id', match.id);
    } catch (_) { /* usage counters are a convenience */ }
    return { ok: true, passcode: { id: match.id, name: match.name, location_id: match.location_id || null } };
}

/** The passcodes as a screen shows them: never the hash. */
async function listPasscodes(companyId) {
    const { data, error } = await supabaseAdmin
        .from('approval_passcodes')
        .select('id, location_id, name, is_active, created_at, created_by, changed_at, last_used_at, use_count')
        .eq('company_id', companyId).order('created_at');
    if (error) {
        if (missingTable(error)) return [];
        throw error;
    }
    return (data || []).map(publicPasscode);
}

/** True when this code is already one of the company's live passcodes (each must point to one name). */
async function passcodeInUse(companyId, code, exceptId) {
    const all = await activePasscodes(companyId, null);
    for (const p of all) {
        if (p.id === exceptId) continue;
        if (await verifyPasscode(code, p.passcode_hash)) return true;
    }
    return false;
}

/**
 * Add a named passcode. Returns { ok, passcode } or { ok: false, status, error }.
 */
async function createPasscode(companyId, { name, passcode, location_id }, actor) {
    const n = cleanName(name);
    if (!n) return { ok: false, status: 400, error: 'Give the passcode a name, such as the manager’s name.' };
    const problem = passcodeProblem(String(passcode === undefined || passcode === null ? '' : passcode).trim());
    if (problem) return { ok: false, status: 400, error: problem };
    const code = String(passcode).trim();
    if (await passcodeInUse(companyId, code)) {
        return { ok: false, status: 409, error: 'That passcode is already in use here. Choose a different one, so every approval shows who gave it.' };
    }
    const existing = await listPasscodes(companyId);
    if (existing.some(p => p.is_active && p.name.toLowerCase() === n.toLowerCase())) {
        return { ok: false, status: 409, error: `There is already a passcode named "${n}".` };
    }
    const { data, error } = await supabaseAdmin.from('approval_passcodes').insert({
        company_id: companyId, location_id: location_id || null, name: n,
        passcode_hash: await hashPasscode(code), created_by: actor || null
    }).select('id, location_id, name, is_active, created_at, created_by, changed_at, last_used_at, use_count').single();
    if (error) {
        if (error.code === '23505') return { ok: false, status: 409, error: `There is already a passcode named "${n}".` };
        throw error;
    }
    return { ok: true, passcode: publicPasscode(data) };
}

/** Rename, re-scope, change the code, or switch a passcode off/on. */
async function updatePasscode(companyId, id, body, actor) {
    const { data: row } = await supabaseAdmin.from('approval_passcodes')
        .select('id, company_id, name, is_active').eq('id', id).eq('company_id', companyId).maybeSingle();
    if (!row) return { ok: false, status: 404, error: 'Passcode not found.' };

    const update = {};
    if ('name' in body) {
        const n = cleanName(body.name);
        if (!n) return { ok: false, status: 400, error: 'A passcode needs a name.' };
        update.name = n;
    }
    if ('location_id' in body) update.location_id = body.location_id || null;
    if ('is_active' in body) update.is_active = body.is_active === true;
    if (body.passcode !== undefined && body.passcode !== null && String(body.passcode).trim() !== '') {
        const code = String(body.passcode).trim();
        const problem = passcodeProblem(code);
        if (problem) return { ok: false, status: 400, error: problem };
        if (await passcodeInUse(companyId, code, id)) {
            return { ok: false, status: 409, error: 'That passcode is already in use here. Choose a different one.' };
        }
        update.passcode_hash = await hashPasscode(code);
        update.changed_at = new Date().toISOString();
    }
    if (!Object.keys(update).length) return { ok: false, status: 400, error: 'Nothing to change.' };

    const { data, error } = await supabaseAdmin.from('approval_passcodes').update(update)
        .eq('id', id).eq('company_id', companyId)
        .select('id, location_id, name, is_active, created_at, created_by, changed_at, last_used_at, use_count').single();
    if (error) {
        if (error.code === '23505') return { ok: false, status: 409, error: 'Another live passcode already has that name.' };
        throw error;
    }
    return { ok: true, passcode: publicPasscode(data) };
}

// ----------------------------------------------------------------------------
// ITEMS THAT NEED A MANAGER
// ----------------------------------------------------------------------------

/** Products with their flag, for the "Staff items" screen. Paged; filters optional. */
async function listItems(companyId, { search, category, brand, only, page = 1, limit = 50 } = {}) {
    const size = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const p = Math.max(1, parseInt(page, 10) || 1);
    let q = supabaseAdmin.from('products')
        .select('id, sku, name, brand, category, price, requires_approval', { count: 'exact' })
        .eq('company_id', companyId).eq('is_active', true)
        .order('category').order('name')
        .range((p - 1) * size, p * size - 1);
    if (category) q = q.eq('category', category);
    if (brand) q = q.eq('brand', brand);
    if (only === 'locked') q = q.eq('requires_approval', true);
    if (only === 'open') q = q.eq('requires_approval', false);
    const term = String(search || '').replace(/[%,()*\\]/g, ' ').trim().slice(0, 60);
    if (term) q = q.or(`name.ilike.%${term}%,sku.ilike.%${term}%`);
    const { data, error, count } = await q;
    if (error) throw error;
    return { items: data || [], total: count || 0, page: p, limit: size };
}

/** Category and brand counts, so a screen can lock "all of Equipment" in one tap. */
async function itemGroups(companyId) {
    const rows = [];
    for (let from = 0; from < 20000; from += 1000) {
        const { data, error } = await supabaseAdmin.from('products')
            .select('category, brand, requires_approval').eq('company_id', companyId).eq('is_active', true)
            .range(from, from + 999);
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < 1000) break;
    }
    const tally = (key) => {
        const m = new Map();
        for (const r of rows) {
            const k = r[key] || '(none)';
            const t = m.get(k) || { name: k, total: 0, locked: 0 };
            t.total++; if (r.requires_approval) t.locked++;
            m.set(k, t);
        }
        return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
    };
    return { categories: tally('category'), brands: tally('brand'), locked: rows.filter(r => r.requires_approval).length, total: rows.length };
}

/**
 * Set the flag on chosen products, or on a whole category or brand.
 * body: { requires_approval, product_ids? , category?, brand? }
 */
async function setItems(companyId, body) {
    const value = body && body.requires_approval === true;
    let q = supabaseAdmin.from('products').update({ requires_approval: value }).eq('company_id', companyId);
    if (Array.isArray(body.product_ids) && body.product_ids.length) {
        const ids = body.product_ids.filter(id => /^[0-9a-f-]{36}$/i.test(String(id))).slice(0, 500);
        if (!ids.length) return { ok: false, status: 400, error: 'No items chosen.' };
        q = q.in('id', ids);
    } else if (body.category) {
        q = q.eq('category', String(body.category).slice(0, 200));
    } else if (body.brand) {
        q = q.eq('brand', String(body.brand).slice(0, 200));
    } else {
        return { ok: false, status: 400, error: 'Choose items, a category or a brand.' };
    }
    const { data, error } = await q.select('id');
    if (error) throw error;
    return { ok: true, changed: (data || []).length };
}

// ----------------------------------------------------------------------------
// WAITING FOR APPROVAL
// ----------------------------------------------------------------------------

/** A passcode as a screen may see it: never the hash. */
const PASSCODE_FIELDS = ['id', 'location_id', 'name', 'is_active', 'created_at', 'created_by', 'changed_at', 'last_used_at', 'use_count'];
function publicPasscode(p) {
    const out = {};
    for (const k of PASSCODE_FIELDS) out[k] = p && p[k] !== undefined ? p[k] : null;
    return out;
}

const APPROVAL_COLUMNS = 'id, company_id, location_id, status, contact_name, contact_email, items, subtotal, total, reasons, created_at, decided_at, decided_by_name, decision_reason, order_id';

async function listApprovals(companyId, { locationId = null, status = 'waiting', limit = 100 } = {}) {
    let q = supabaseAdmin.from('order_approvals').select(APPROVAL_COLUMNS)
        .eq('company_id', companyId).order('created_at', { ascending: false }).limit(limit);
    if (status) q = q.eq('status', status);
    if (locationId) q = q.eq('location_id', locationId);
    const { data, error } = await q;
    if (error) {
        if (missingTable(error)) return [];
        throw error;
    }
    return data || [];
}

async function waitingCount(companyId, locationId) {
    try {
        let q = supabaseAdmin.from('order_approvals').select('id', { count: 'exact', head: true })
            .eq('company_id', companyId).eq('status', 'waiting');
        if (locationId) q = q.eq('location_id', locationId);
        const { count, error } = await q;
        return error ? 0 : (count || 0);
    } catch (_) { return 0; }
}

/** A short random id for an approval that a person reads out ("approval 7F3K"). */
function shortRef(id) {
    return String(id || crypto.randomUUID()).replace(/-/g, '').slice(0, 6).toUpperCase();
}

module.exports = {
    RULE_KEYS, DEFAULT_HOLD_MESSAGE, MAX_FAILS, PASSCODE_MIN, PASSCODE_MAX,
    missingTable, money,
    effectiveRules, anyOn, evaluate, normalizeRulesPatch, cleanName,
    loadRuleRows, rulesFor, saveRules,
    stockPosition, markLockedLines, checkOrder,
    activePasscodes, verifyApprovalPasscode, listPasscodes, createPasscode, updatePasscode,
    listItems, itemGroups, setItems,
    APPROVAL_COLUMNS, listApprovals, waitingCount, shortRef
};
