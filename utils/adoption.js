/**
 * utils/adoption.js
 *
 * The weekly adoption report: which shops are actually using the ordering
 * console, week by week, next to what they ordered and who ordered it.
 *
 * Pure functions only -- no database, no clock of their own -- so the week
 * boundaries and the counting can be tested exactly. The route
 * (routes/admin-adoption.js) reads the rows and hands them here.
 *
 * WHAT COUNTS AS "USING IT"
 * -------------------------
 *   - A shop "entered the store" when someone signed in, picked that shop and
 *     reached the ordering screen (console_visits event `enter`, which carries
 *     the location). This is the only record of WHICH shop signed in; the
 *     sign-in itself (`login`) happens before a shop is chosen.
 *   - A shop "ordered" when an order was placed for it (cancelled orders are
 *     not counted as sales).
 *   - A shop is ACTIVE in a week if it did either.
 *   - Named sign-ins (company_user_logins) exist only for customers who sign in
 *     as individuals (the People & activity module). Customers on the shared
 *     access code cannot be told apart by person; for them "who" comes from
 *     the contact name on the order.
 *
 * Weeks run Monday to Sunday in Toronto time (CHC's clock), whatever time zone
 * the server is in.
 */

const { moduleEnabled } = require('./modules');

const TZ = 'America/Toronto';
const DAY = 864e5;

const partsFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short'
});

function parts(date) {
    const o = {};
    for (const p of partsFmt.formatToParts(date)) o[p.type] = p.value;
    return {
        y: Number(o.year), m: Number(o.month), d: Number(o.day),
        h: Number(o.hour), mi: Number(o.minute), s: Number(o.second),
        dow: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(o.weekday)   // Monday = 0
    };
}

/** The instant at which Toronto's wall clock reads y-m-d 00:00. */
function torontoMidnight(y, m, d) {
    let t = Date.UTC(y, m - 1, d);
    // Two passes settle the offset even on a daylight-saving date.
    for (let i = 0; i < 2; i++) {
        const p = parts(new Date(t));
        const shown = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
        t -= (shown - Date.UTC(y, m - 1, d));
    }
    return new Date(t);
}

/** Monday 00:00 (Toronto) of the week that contains `date`. */
function weekStart(date) {
    const p = parts(date);
    const monday = new Date(Date.UTC(p.y, p.m - 1, p.d) - p.dow * DAY);
    return torontoMidnight(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate());
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(date) {
    const p = parts(date);
    return `${MONTHS[p.m - 1]} ${p.d}`;
}

/**
 * The last `count` weeks, oldest first. The final one is the week `now` is in
 * and is marked `current` -- it is still filling up, and the screen says so.
 */
function weekRanges(count, now = new Date()) {
    const n = Math.max(1, Math.min(52, Number(count) || 8));
    const thisStart = weekStart(now);
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
        // Step back by whole weeks from the current Monday, re-deriving each
        // Monday from the calendar so a daylight-saving change cannot shift one.
        const approx = new Date(thisStart.getTime() - i * 7 * DAY + 12 * 3600e3);
        const start = weekStart(approx);
        const next = weekStart(new Date(start.getTime() + 7 * DAY + 12 * 3600e3));
        const last = new Date(next.getTime() - DAY);
        out.push({
            start: start.toISOString(),
            end: next.toISOString(),
            label: `${shortDate(start)} – ${shortDate(new Date(last.getTime() + 12 * 3600e3))}`,
            current: i === 0
        });
    }
    return out;
}

function indexOfWeek(ts, ranges, starts) {
    const t = new Date(ts).getTime();
    if (!Number.isFinite(t)) return -1;
    for (let i = ranges.length - 1; i >= 0; i--) {
        if (t >= starts[i]) return t < new Date(ranges[i].end).getTime() ? i : -1;
    }
    return -1;
}

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const cleanName = s => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * Fold the raw rows into the report.
 *
 * @param {Object} i
 * @param {Array}  i.companies   [{id, name, settings}]
 * @param {Array}  i.locations   [{id, company_id, name, city, is_active, supplier_branch_id}]
 * @param {Array}  i.branches    [{id, name}]
 * @param {Array}  i.visits      [{company_id, location_id, event, session_id, created_at}]
 * @param {Array}  i.orders      [{company_id, location_id, total, status, created_at, contact_name, placed_by_name}]
 * @param {Array}  i.userLogins  [{company_id, user_id, email, name, event, created_at}]
 * @param {Array}  i.ranges      from weekRanges()
 */
function buildAdoption({ companies = [], locations = [], branches = [], visits = [], orders = [], userLogins = [], ranges }) {
    const starts = ranges.map(r => new Date(r.start).getTime());
    const W = ranges.length;
    const cur = W - 1;
    const prev = W - 2;

    const companyName = new Map(companies.map(c => [c.id, c.name]));
    const branchName = new Map(branches.map(b => [b.id, b.name]));
    const companyIds = new Set(companies.map(c => c.id));

    const zeros = () => new Array(W).fill(0);
    const blank = (loc) => ({
        location_id: loc.id,
        company_id: loc.company_id,
        company_name: companyName.get(loc.company_id) || 'Unknown company',
        location: loc.name,
        city: loc.city || '',
        branch: branchName.get(loc.supplier_branch_id) || '',
        entries: zeros(), sessions: zeros(), orders: zeros(), dollars: zeros(),
        _sessions: ranges.map(() => new Set()),
        _people: new Map(),
        last_seen: null
    });

    const byLoc = new Map();
    for (const l of locations) {
        if (!companyIds.has(l.company_id)) continue;
        byLoc.set(l.id, { row: blank(l), active: l.is_active !== false });
    }
    const touch = (row, ts) => { if (!row.last_seen || ts > row.last_seen) row.last_seen = ts; };

    // Store entries: the only event that names a shop.
    const loginsByCompany = new Map();
    for (const v of visits) {
        if (!companyIds.has(v.company_id)) continue;
        const w = indexOfWeek(v.created_at, ranges, starts);
        if (w < 0) continue;
        if (v.event === 'login') {
            const c = loginsByCompany.get(v.company_id) || zeros();
            c[w] += 1;
            loginsByCompany.set(v.company_id, c);
            continue;
        }
        if (v.event !== 'enter' || !v.location_id) continue;
        const hit = byLoc.get(v.location_id);
        if (!hit) continue;
        hit.row.entries[w] += 1;
        if (v.session_id) hit.row._sessions[w].add(v.session_id);
        else hit.row._sessions[w].add(`anon-${hit.row.entries[w]}`);
        touch(hit.row, v.created_at);
    }

    // Orders: dollars and people, per shop.
    let unassignedOrders = 0;
    for (const o of orders) {
        if (String(o.status) === 'cancelled') continue;
        if (!companyIds.has(o.company_id)) continue;
        const w = indexOfWeek(o.created_at, ranges, starts);
        if (w < 0) continue;
        const hit = o.location_id ? byLoc.get(o.location_id) : null;
        if (!hit) { unassignedOrders += 1; continue; }
        hit.row.orders[w] += 1;
        hit.row.dollars[w] += Number(o.total) || 0;
        touch(hit.row, o.created_at);
        const who = cleanName(o.placed_by_name || o.contact_name) || 'Unnamed';
        const p = hit._people || (hit._people = new Map());
        const cur2 = p.get(who.toLowerCase()) || { name: who, orders: 0, dollars: 0 };
        cur2.orders += 1;
        cur2.dollars += Number(o.total) || 0;
        p.set(who.toLowerCase(), cur2);
    }

    const locOut = [];
    for (const { row, active, _people = new Map() } of byLoc.values()) {
        row.sessions = row._sessions.map(s => s.size);
        delete row._sessions;
        delete row._people;
        row.dollars = row.dollars.map(round2);
        const total = {
            entries: row.entries.reduce((a, b) => a + b, 0),
            orders: row.orders.reduce((a, b) => a + b, 0),
            dollars: round2(row.dollars.reduce((a, b) => a + b, 0))
        };
        const activeWeeks = row.entries.map((e, k) => (e > 0 || row.orders[k] > 0) ? 1 : 0);
        row.active_weeks = activeWeeks;
        row.weeks_active = activeWeeks.reduce((a, b) => a + b, 0);
        row.totals = total;
        row.people = [..._people.values()]
            .map(p => ({ name: p.name, orders: p.orders, dollars: round2(p.dollars) }))
            .sort((a, b) => b.dollars - a.dollars || a.name.localeCompare(b.name));
        row.status = activeWeeks[cur] ? 'active_this_week'
            : (W > 1 && activeWeeks[prev]) ? 'active_last_week'
            : row.weeks_active ? 'active_earlier'
            : 'no_activity';
        // A shop that is switched off and never did anything is noise.
        if (!active && !row.weeks_active) continue;
        row.is_active = active;
        locOut.push(row);
    }
    locOut.sort((a, b) => a.company_name.localeCompare(b.company_name) || a.location.localeCompare(b.location));

    // Named sign-ins (customers who sign in as individuals).
    const peopleMap = new Map();
    for (const l of userLogins) {
        if (l.event !== 'login' || !companyIds.has(l.company_id)) continue;
        if (indexOfWeek(l.created_at, ranges, starts) < 0) continue;
        const key = `${l.company_id}|${l.user_id || String(l.email || '').toLowerCase()}`;
        const p = peopleMap.get(key) || {
            company_id: l.company_id, company_name: companyName.get(l.company_id) || '',
            name: cleanName(l.name) || String(l.email || 'Unknown'), email: l.email || '',
            sign_ins: 0, this_week: 0, last_sign_in: null
        };
        p.sign_ins += 1;
        if (indexOfWeek(l.created_at, ranges, starts) === cur) p.this_week += 1;
        if (!p.last_sign_in || l.created_at > p.last_sign_in) p.last_sign_in = l.created_at;
        peopleMap.set(key, p);
    }
    const people = [...peopleMap.values()]
        .sort((a, b) => String(b.last_sign_in).localeCompare(String(a.last_sign_in)));

    // Company roll-up.
    const companiesOut = companies.map(c => {
        const mine = locOut.filter(l => l.company_id === c.id && l.is_active);
        const named = people.filter(p => p.company_id === c.id);
        const logins = loginsByCompany.get(c.id) || zeros();
        const activeNow = mine.filter(l => l.active_weeks[cur]).length;
        const activePrev = W > 1 ? mine.filter(l => l.active_weeks[prev]).length : 0;
        return {
            company_id: c.id, company_name: c.name,
            locations_total: mine.length,
            active_this_week: activeNow,
            active_last_week: activePrev,
            adoption_pct: mine.length ? Math.round((activeNow / mine.length) * 100) : 0,
            sign_ins_this_week: logins[cur] || 0,
            sign_ins_period: logins.reduce((a, b) => a + b, 0),
            named_people_signed_in: named.length,
            individual_logins: moduleEnabled(c.settings, 'activity'),
            orders: locOut.filter(l => l.company_id === c.id).reduce((a, l) => a + l.totals.orders, 0),
            dollars: round2(locOut.filter(l => l.company_id === c.id).reduce((a, l) => a + l.totals.dollars, 0))
        };
    }).sort((a, b) => a.company_name.localeCompare(b.company_name));

    const live = locOut.filter(l => l.is_active);
    const totals = {
        locations: live.length,
        active_this_week: live.filter(l => l.active_weeks[cur]).length,
        active_last_week: W > 1 ? live.filter(l => l.active_weeks[prev]).length : 0,
        no_activity: live.filter(l => !l.weeks_active).length,
        orders_this_week: locOut.reduce((a, l) => a + l.orders[cur], 0),
        dollars_this_week: round2(locOut.reduce((a, l) => a + l.dollars[cur], 0)),
        unassigned_orders: unassignedOrders
    };

    return { weeks: ranges, totals, companies: companiesOut, locations: locOut, people };
}

module.exports = { TZ, weekStart, weekRanges, buildAdoption, torontoMidnight };
