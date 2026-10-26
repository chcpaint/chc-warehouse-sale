/**
 * tests/adoption-report.test.js
 *
 * The weekly adoption report. The ways this report can look right while being
 * wrong:
 *
 *   - a week boundary drawn in UTC, so Sunday-evening orders land in next week
 *   - a cancelled order counted as a shop "using" the console
 *   - a shop that never signed in vanishing instead of showing as no activity
 *   - one company's shops (or people) visible to another company's admin
 *   - a customer-typed name starting with "=" running as a spreadsheet formula
 *   - the whole report failing because an optional log table is missing
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { createFakeSupabase } = require('./helpers/fake-supabase');

const ROOT = path.resolve(__dirname, '..');
let fake = createFakeSupabase();
let authAdmin = { id: 'admin-1', role: 'super_admin', company_id: null };

const supabaseProxy = new Proxy({}, {
    get: (_t, prop) => {
        const v = fake[prop];
        return typeof v === 'function' ? v.bind(fake) : v;
    }
});

const stubs = {
    [path.join(ROOT, 'utils/supabase.js')]: { supabaseAdmin: supabaseProxy },
    [path.join(ROOT, 'utils/sanitize.js')]: {
        stripHtml: s => String(s ?? ''),
        sanitizeObject: o => o,
        isValidUUID: v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '')),
        generateSlug: s => s,
        validateEmail: () => true
    }
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (parent && request.startsWith('.')) {
        const resolved = path.resolve(path.dirname(parent.filename), request);
        for (const key of Object.keys(stubs)) {
            if (key === resolved || key === resolved + '.js') return stubs[key];
        }
    }
    return originalLoad.call(this, request, parent, isMain);
};

const express = require('express');
const request = require('supertest');
const adoption = require('../routes/admin-adoption');
const { weekStart, weekRanges, buildAdoption } = require('../utils/adoption');
const { restrictOrderDesk } = require('../middleware/auth');

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const BRANCH = '99999999-9999-4999-8999-999999999999';
const L_REGENT = '44444444-4444-4444-8444-444444444441';
const L_ARMSTRONG = '44444444-4444-4444-8444-444444444442';
const L_QUIET = '44444444-4444-4444-8444-444444444443';
const L_OTHER = '44444444-4444-4444-8444-444444444444';

const NOW = Date.now();
const ago = ms => new Date(NOW - ms).toISOString();
const THIS_WEEK = ago(1000);            // one second ago: in the current week
const LAST_WEEK = ago(7 * 864e5);       // exactly a week ago: in the previous week

function seed(extra = {}) {
    return createFakeSupabase({
        companies: [
            { id: CO_A, name: 'Assured', slug: 'assured', is_active: true, settings: {} },
            { id: CO_B, name: 'Bayview', slug: 'bayview', is_active: true,
              settings: { users: { enabled: true }, activity: { enabled: true } } }
        ],
        supplier_branches: [{ id: BRANCH, name: 'Woodbridge' }],
        company_locations: [
            { id: L_REGENT, company_id: CO_A, name: 'Assured - Regent Collision', city: 'Sudbury', is_active: true, supplier_branch_id: BRANCH },
            { id: L_ARMSTRONG, company_id: CO_A, name: 'Assured - Armstrong Collision', city: 'Sudbury', is_active: true, supplier_branch_id: BRANCH },
            { id: L_QUIET, company_id: CO_A, name: 'Assured - Quiet', city: 'Toronto', is_active: true },
            { id: L_OTHER, company_id: CO_B, name: 'Bayview Main', city: 'Oakville', is_active: true }
        ],
        console_visits: [
            { id: 'v1', company_id: CO_A, event: 'login', location_id: null, session_id: 's1', created_at: THIS_WEEK },
            { id: 'v2', company_id: CO_A, event: 'enter', location_id: L_REGENT, session_id: 's1', created_at: THIS_WEEK },
            { id: 'v3', company_id: CO_A, event: 'enter', location_id: L_REGENT, session_id: 's1', created_at: THIS_WEEK },
            { id: 'v4', company_id: CO_A, event: 'enter', location_id: L_REGENT, session_id: 's2', created_at: THIS_WEEK },
            { id: 'v5', company_id: CO_A, event: 'enter', location_id: L_ARMSTRONG, session_id: 's3', created_at: LAST_WEEK },
            { id: 'v6', company_id: CO_A, event: 'visit', location_id: null, session_id: 's9', created_at: THIS_WEEK },
            { id: 'v7', company_id: CO_B, event: 'enter', location_id: L_OTHER, session_id: 's4', created_at: THIS_WEEK }
        ],
        orders: [
            { id: 'o1', company_id: CO_A, location_id: L_REGENT, total: 100, status: 'pending', created_at: THIS_WEEK, contact_name: 'Dana' },
            { id: 'o2', company_id: CO_A, location_id: L_REGENT, total: 50, status: 'closed', created_at: THIS_WEEK, contact_name: 'Dana' },
            { id: 'o3', company_id: CO_A, location_id: L_REGENT, total: 900, status: 'cancelled', created_at: THIS_WEEK, contact_name: 'Dana' },
            { id: 'o4', company_id: CO_A, location_id: L_ARMSTRONG, total: 70, status: 'pending', created_at: LAST_WEEK, contact_name: '=cmd()' },
            { id: 'o5', company_id: CO_B, location_id: L_OTHER, total: 10, status: 'pending', created_at: THIS_WEEK, contact_name: 'Bob' }
        ],
        company_user_logins: [
            { id: 'u1', company_id: CO_B, user_id: 'p1', email: 'bob@bayview.ca', name: 'Bob', event: 'login', created_at: THIS_WEEK },
            { id: 'u2', company_id: CO_B, user_id: 'p1', email: 'bob@bayview.ca', name: 'Bob', event: 'login', created_at: THIS_WEEK },
            { id: 'u3', company_id: CO_B, user_id: 'p1', email: 'bob@bayview.ca', name: 'Bob', event: 'failed', created_at: THIS_WEEK }
        ],
        ...extra
    });
}

function app() {
    const a = express();
    a.use(express.json());
    a.use((req, res, next) => { req.admin = authAdmin; next(); });
    a.use('/adoption', adoption);
    return a;
}
function reset(extra) {
    fake = seed(extra);
    authAdmin = { id: 'admin-1', role: 'super_admin', company_id: null };
}
const get = url => request(app()).get(url);

// ------------------------------------------------------------------
// Weeks
// ------------------------------------------------------------------

test('weeks run Monday to Sunday on Toronto time, not UTC', () => {
    // Sunday 23:30 in Toronto is already Monday in UTC. It is still last week.
    assert.equal(weekStart(new Date('2026-10-19T03:30:00Z')).toISOString(), '2026-10-12T04:00:00.000Z');
    // A few minutes after Toronto's midnight it is the new week.
    assert.equal(weekStart(new Date('2026-10-19T04:10:00Z')).toISOString(), '2026-10-19T04:00:00.000Z');
});

test('weeks stay Monday-aligned across the November clock change', () => {
    const r = weekRanges(3, new Date('2026-11-04T15:00:00Z'));
    assert.deepEqual(r.map(w => w.start), [
        '2026-10-19T04:00:00.000Z', '2026-10-26T04:00:00.000Z', '2026-11-02T05:00:00.000Z'
    ]);
    assert.equal(r[2].current, true);
    assert.equal(r[0].current, false);
});

// ------------------------------------------------------------------
// The report
// ------------------------------------------------------------------

test('counts store entries, sessions, orders and dollars per shop per week', async () => {
    reset();
    const res = await get('/adoption?weeks=4');
    assert.equal(res.status, 200);
    const regent = res.body.locations.find(l => l.location_id === L_REGENT);
    const cur = res.body.weeks.length - 1;
    assert.equal(regent.entries[cur], 3);
    assert.equal(regent.sessions[cur], 2, 'two people signed in, one of them entered twice');
    assert.equal(regent.orders[cur], 2);
    assert.equal(regent.dollars[cur], 150);
    assert.equal(regent.branch, 'Woodbridge');
    assert.equal(regent.status, 'active_this_week');
});

test('a cancelled order is not use and not dollars', async () => {
    reset();
    const res = await get('/adoption?weeks=4');
    const regent = res.body.locations.find(l => l.location_id === L_REGENT);
    assert.equal(regent.totals.orders, 2);
    assert.equal(regent.totals.dollars, 150, 'the 900 cancelled order must not count');
});

test('a shop that never signed in is a row with no activity, not an omission', async () => {
    reset();
    const res = await get('/adoption?weeks=4');
    const quiet = res.body.locations.find(l => l.location_id === L_QUIET);
    assert.ok(quiet);
    assert.equal(quiet.status, 'no_activity');
    assert.equal(quiet.weeks_active, 0);
});

test('last week counts as last week', async () => {
    reset();
    const res = await get('/adoption?weeks=4');
    const arm = res.body.locations.find(l => l.location_id === L_ARMSTRONG);
    assert.equal(arm.status, 'active_last_week');
    assert.equal(res.body.totals.active_this_week, 2);      // Regent + Bayview Main
    assert.equal(res.body.totals.active_last_week, 1);      // Armstrong
    assert.equal(res.body.totals.no_activity, 1);           // Quiet
});

test('company roll-up shows adoption and shop sign-ins', async () => {
    reset();
    const res = await get('/adoption?weeks=4');
    const a = res.body.companies.find(c => c.company_id === CO_A);
    assert.equal(a.locations_total, 3);
    assert.equal(a.active_this_week, 1);
    assert.equal(a.adoption_pct, 33);
    assert.equal(a.sign_ins_this_week, 1);
    assert.equal(a.individual_logins, false);
    const b = res.body.companies.find(c => c.company_id === CO_B);
    assert.equal(b.individual_logins, true);
});

test('who ordered, per shop, comes from the order contact', async () => {
    reset();
    const res = await get('/adoption?weeks=4');
    const regent = res.body.locations.find(l => l.location_id === L_REGENT);
    assert.deepEqual(regent.people, [{ name: 'Dana', orders: 2, dollars: 150 }]);
});

test('named sign-ins count successful logins only, per person', async () => {
    reset();
    const res = await get('/adoption?weeks=4');
    assert.equal(res.body.people.length, 1);
    assert.equal(res.body.people[0].name, 'Bob');
    assert.equal(res.body.people[0].sign_ins, 2, 'the failed attempt is not a sign-in');
    assert.equal(res.body.people[0].this_week, 2);
});

test('a company admin sees only their own company', async () => {
    reset();
    authAdmin = { id: 'admin-2', role: 'admin', company_id: CO_B };
    const res = await get(`/adoption?weeks=4&company_id=${CO_A}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.companies.map(c => c.company_id), [CO_B]);
    assert.ok(res.body.locations.every(l => l.company_id === CO_B), 'asking for another company must not widen the view');
    assert.ok(res.body.people.every(p => p.company_id === CO_B));
});

test('a super admin can narrow to one company', async () => {
    reset();
    const res = await get(`/adoption?weeks=4&company_id=${CO_A}`);
    assert.deepEqual(res.body.companies.map(c => c.company_id), [CO_A]);
});

test('order-desk accounts cannot reach it', async () => {
    reset();
    const a = express();
    a.use((req, res, next) => { req.admin = { id: 'd', role: 'order_desk', company_id: null }; next(); });
    a.use(restrictOrderDesk);
    a.use('/adoption', adoption);
    const res = await request(a).get('/adoption?weeks=4');
    assert.equal(res.status, 403);
});

test('the report still loads when an optional log table is missing', async () => {
    reset();
    const realFrom = fake.from.bind(fake);
    fake.from = (t) => {
        if (t === 'console_visits') throw new Error('relation "console_visits" does not exist');
        return realFrom(t);
    };
    const res = await get('/adoption?weeks=4');
    assert.equal(res.status, 200);
    assert.ok(res.body.notes.length >= 1);
    const regent = res.body.locations.find(l => l.location_id === L_REGENT);
    assert.equal(regent.orders[res.body.weeks.length - 1], 2, 'orders still report');
});

test('weeks is clamped to something sensible', async () => {
    reset();
    assert.equal((await get('/adoption?weeks=0')).body.weeks.length, 8);
    assert.equal((await get('/adoption?weeks=500')).body.weeks.length, 52);
    assert.equal((await get('/adoption?weeks=nope')).body.weeks.length, 8);
});

// ------------------------------------------------------------------
// CSV
// ------------------------------------------------------------------

test('CSV has one row per shop per week and defuses formulas', async () => {
    reset();
    const res = await get('/adoption/csv?weeks=2');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/csv/);
    const lines = res.text.split('\n');
    assert.equal(lines.length, 1 + 4 * 2, 'header + 4 shops x 2 weeks');
    assert.ok(lines[0].startsWith('Company,Shop,City,CHC branch,Week starting'));
    assert.ok(res.text.includes("'=cmd()"), 'a typed name beginning with = must be quoted off');
    assert.ok(!/(^|,)=cmd\(\)/m.test(res.text));
});

test('buildAdoption on nothing returns an empty, well-formed report', () => {
    const r = buildAdoption({ ranges: weekRanges(4, new Date()) });
    assert.equal(r.locations.length, 0);
    assert.equal(r.totals.locations, 0);
    assert.equal(r.weeks.length, 4);
});
