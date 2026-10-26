/**
 * tests/adoption-digest.test.js
 *
 * The Monday adoption email. What can go wrong with a scheduled email:
 *
 *   - it goes to the wrong people (a typo'd address on the standing list)
 *   - it reports the week that is only a few hours old instead of the one that finished
 *   - it goes out twice, or on the wrong day, or at midnight
 *   - one failed send means nobody is ever told
 *   - a shop name with markup in it breaks or hijacks the email
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
let authAdmin = { id: 'admin-1', role: 'super_admin', company_id: null, email: 'adam@chcpaint.com' };
const outbox = [];
let sendResult = { sent: true };

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
    },
    [path.join(ROOT, 'utils/email.js')]: {
        sendAdoptionReport: async (mail) => { outbox.push(mail); return sendResult; },
        sendLowStockAlert: async () => ({ sent: true }),
        sendReorderRaised: async () => ({ sent: true })
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
const digest = require('../utils/adoption-digest');
const scheduler = require('../utils/scheduler');

const CO = '11111111-1111-4111-8111-111111111111';
const L1 = '44444444-4444-4444-8444-444444444441';
const L2 = '44444444-4444-4444-8444-444444444442';
const L3 = '44444444-4444-4444-8444-444444444443';

// Monday 2026-10-19, 07:30 Toronto (EDT, UTC-4) = 11:30 UTC.
const MONDAY_0730 = new Date('2026-10-19T11:30:00Z');
// Mid-week of the finished week (Wed Oct 14, noon Toronto) and of the new one.
const LAST_WEEK_WED = new Date('2026-10-14T16:00:00Z').toISOString();
const THIS_WEEK_MON = new Date('2026-10-19T06:00:00Z').toISOString();   // 02:00 Monday

function seed() {
    return createFakeSupabase({
        companies: [{ id: CO, name: 'Assured', slug: 'assured', is_active: true, settings: {} }],
        supplier_branches: [],
        company_locations: [
            { id: L1, company_id: CO, name: 'Assured - Regent Collision', city: 'Sudbury', is_active: true },
            { id: L2, company_id: CO, name: '<b>Armstrong</b>', city: 'Sudbury', is_active: true },
            { id: L3, company_id: CO, name: 'Assured - Quiet', city: 'Toronto', is_active: true }
        ],
        console_visits: [
            { company_id: CO, event: 'enter', location_id: L1, session_id: 's1', created_at: LAST_WEEK_WED },
            { company_id: CO, event: 'enter', location_id: L3, session_id: 's9', created_at: THIS_WEEK_MON }
        ],
        orders: [
            { id: 'o1', company_id: CO, location_id: L1, total: 250, status: 'pending', created_at: LAST_WEEK_WED, contact_name: 'Dana' },
            { id: 'o2', company_id: CO, location_id: L2, total: 80, status: 'pending', created_at: LAST_WEEK_WED, contact_name: '<script>x</script>' }
        ],
        company_user_logins: []
    });
}

function reset() {
    fake = seed();
    outbox.length = 0;
    sendResult = { sent: true };
    authAdmin = { id: 'admin-1', role: 'super_admin', company_id: null, email: 'adam@chcpaint.com' };
}

// ------------------------------------------------------------------
// Recipients
// ------------------------------------------------------------------

test('the standing list is the six people asked for, with Frank at frankc@', () => {
    assert.deepEqual(digest.recipients({}), [
        'adam@chcpaint.com', 'gabe@chcpaint.com', 'manny@chcpaint.com',
        'frankc@chcpaint.com', 'pino@chcpaint.com', 'daniel@chcpaint.com'
    ]);
    assert.ok(!digest.recipients({}).includes('frank@chcpaint.com'));
});

test('the list can be overridden, and bad or repeated addresses are dropped', () => {
    const list = digest.recipients({ ADOPTION_REPORT_RECIPIENTS: 'A@x.ca, a@x.ca; nonsense, b@x.ca' });
    assert.deepEqual(list, ['a@x.ca', 'b@x.ca']);
});

// ------------------------------------------------------------------
// The week it covers
// ------------------------------------------------------------------

test('on Monday morning it reports the week that just finished', () => {
    const end = digest.endOfLastWeek(MONDAY_0730);
    // 23:59:59 Sunday Toronto = 03:59:59 UTC Monday.
    assert.equal(end.toISOString(), '2026-10-19T03:59:59.000Z');
});

test('the email counts last week, not the few hours of the new week', async () => {
    reset();
    const out = await digest.sendDigestNow({ now: MONDAY_0730 });
    assert.equal(out.sent, true);
    assert.equal(out.week, 'Oct 12 – Oct 18');
    const mail = outbox[0];
    assert.match(mail.subject, /Oct 12 – Oct 18: 2 of 3 shops active/);
    assert.ok(mail.html.includes('$250.00'));
    assert.ok(mail.text.includes('2 order(s), $330.00'));
    // The Quiet shop's entry at 02:00 Monday belongs to the NEW week.
    assert.ok(mail.text.includes('No activity in the last 8 weeks: Assured - Quiet'));
});

test('it sends one copy per recipient list, to everyone on it', async () => {
    reset();
    await digest.sendDigestNow({ now: MONDAY_0730 });
    assert.deepEqual(outbox[0].to, digest.recipients({}));
});

test('names typed by customers cannot inject markup into the email', async () => {
    reset();
    await digest.sendDigestNow({ now: MONDAY_0730 });
    const html = outbox[0].html;
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<b>Armstrong</b>'));
    assert.ok(html.includes('&lt;b&gt;Armstrong&lt;/b&gt;'));
});

// ------------------------------------------------------------------
// Send now (screen button)
// ------------------------------------------------------------------

function app() {
    const a = express();
    a.use(express.json());
    a.use((req, res, next) => { req.admin = authAdmin; next(); });
    a.use('/adoption', adoption);
    return a;
}

test('the screen shows who gets the email, to super admins only', async () => {
    reset();
    const sa = await request(app()).get('/adoption?weeks=4');
    assert.deepEqual(sa.body.digest.recipients, digest.recipients({}));
    authAdmin = { id: 'a2', role: 'admin', company_id: CO, email: 'owner@assured.ca' };
    const co = await request(app()).get('/adoption?weeks=4');
    assert.equal(co.body.digest, undefined, 'a customer must not see CHC staff addresses');
});

test('"send me a test" goes only to the person asking', async () => {
    reset();
    const res = await request(app()).post('/adoption/email-now').send({ test: true });
    assert.equal(res.status, 200);
    assert.deepEqual(outbox[0].to, ['adam@chcpaint.com']);
});

test('only a super admin can send it to the team', async () => {
    reset();
    authAdmin = { id: 'a2', role: 'admin', company_id: CO, email: 'owner@assured.ca' };
    const res = await request(app()).post('/adoption/email-now').send({});
    assert.equal(res.status, 403);
    assert.equal(outbox.length, 0);
});

test('a failed send is reported honestly, not as success', async () => {
    reset();
    sendResult = { sent: false, reason: 'not_configured' };
    const res = await request(app()).post('/adoption/email-now').send({});
    assert.equal(res.status, 502);
    assert.match(res.body.error, /not set up/);
});

// ------------------------------------------------------------------
// The Monday job
// ------------------------------------------------------------------

function at(date, fn) {
    const mock = require('node:test').mock;
    mock.timers.enable({ apis: ['Date'], now: date });
    return Promise.resolve().then(fn).finally(() => mock.timers.reset());
}

test('Monday 7:30 Toronto sends once; a second tick and a second instance do not resend', async () => {
    reset();
    const first = await at(MONDAY_0730, () => scheduler.adoptionDigestJob());
    assert.equal(first.sent, true);
    assert.equal(first.recipients, 6);
    const second = await at(new Date(MONDAY_0730.getTime() + 10 * 60e3), () => scheduler.adoptionDigestJob());
    assert.equal(second.skipped, 'already_claimed');
    assert.equal(outbox.length, 1);
});

test('it does not send on other days or outside the morning window', async () => {
    reset();
    const tuesday = await at(new Date('2026-10-20T11:30:00Z'), () => scheduler.adoptionDigestJob());
    assert.equal(tuesday.skipped, 'not_monday');
    const earlier = await at(new Date('2026-10-19T08:30:00Z'), () => scheduler.adoptionDigestJob());   // 04:30 Toronto
    assert.equal(earlier.skipped, 'not_due');
    const afternoon = await at(new Date('2026-10-19T19:00:00Z'), () => scheduler.adoptionDigestJob()); // 15:00 Toronto
    assert.equal(afternoon.skipped, 'not_due');
    assert.equal(outbox.length, 0);
});

test('a restart late in the morning still sends (catch-up window)', async () => {
    reset();
    const late = await at(new Date('2026-10-19T13:50:00Z'), () => scheduler.adoptionDigestJob());   // 09:50 Toronto
    assert.equal(late.sent, true);
});

test('a failed send releases the claim so the next tick tries again', async () => {
    reset();
    sendResult = { sent: false, error: 'SendGrid is down' };
    const bad = await at(MONDAY_0730, () => scheduler.adoptionDigestJob());
    assert.equal(bad.sent, false);
    assert.equal(bad.retry, true);
    sendResult = { sent: true };
    const good = await at(new Date(MONDAY_0730.getTime() + 10 * 60e3), () => scheduler.adoptionDigestJob());
    assert.equal(good.sent, true, 'one bad send must not mean nobody is ever told');
    assert.equal(outbox.filter(m => m).length, 2, 'one failed attempt, one success');
});

test('daylight saving does not move the send off Monday morning', async () => {
    reset();
    // Monday 2026-11-02 07:30 Toronto is EST (UTC-5) = 12:30 UTC, the first Monday after the clocks go back.
    const out = await at(new Date('2026-11-02T12:30:00Z'), () => scheduler.adoptionDigestJob());
    assert.equal(out.sent, true);
});
