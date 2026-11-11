/**
 * tests/insights.test.js -- Insights (AI) on the Reports screen.
 *
 * Proves: what is sent (and never sent), the one-call shape of the request,
 * every access rule, the daily limit, hidden pricing, and that every call is
 * logged to ai_usage_log.
 */
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { createFakeSupabase } = require('./helpers/fake-supabase');
const { summarizeOrders, summarizeInventory } = require('../utils/insights-data');
const { generateInsights, cleanInsights, SYSTEM } = require('../utils/insights');

const ROOT = path.resolve(__dirname, '..');
const CO = '11111111-1111-4111-8111-111111111111';
const LOC_A = '33333333-3333-4333-8333-333333333333';
const LOC_B = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';
const P1 = '66666666-6666-4666-8666-666666666666';
const DAY = 86400000;
const iso = d => new Date(Date.now() - d * DAY).toISOString();

const ORDERS = [
    { id: 'o1', company_id: CO, status: 'closed', total: 400, created_at: iso(10), location_id: LOC_A, location: 'Main',
      contact_name: 'Pat Painter', contact_email: 'pat@shop.invalid', po_number: 'PO-777', notes: 'call Pat',
      items: [{ product_id: P1, sku: 'MMM02023', name: 'Wetordry P1500', quantity: 4, unit_price: 87.99, subtotal: 351.96, category: 'Abrasives' }] },
    { id: 'o2', company_id: CO, status: 'processing', total: 120, created_at: iso(40), location_id: LOC_B, location: 'Vaughan',
      contact_name: 'Sam', items: [{ product_id: P1, sku: 'MMM02023', name: 'Wetordry P1500', quantity: 1, unit_price: 87.99, subtotal: 87.99 }] },
    { id: 'o3', company_id: CO, status: 'closed', total: 900, created_at: iso(120), location_id: LOC_A, location: 'Main',
      contact_name: 'Pat Painter', items: [{ product_id: P1, sku: 'MMM02023', name: 'Wetordry P1500', quantity: 10, unit_price: 87.99, subtotal: 879.9 }] }
];

const PERSONAL = /Pat|Sam|pat@|PO-777|call Pat/;

test('the snapshot carries numbers and product names, never people, emails, PO numbers or notes', () => {
    const s = summarizeOrders(ORDERS);
    const json = JSON.stringify(s);
    assert.ok(!PERSONAL.test(json), json);
    assert.equal(s.orders.current, 2);
    assert.equal(s.orders.previous, 1);
    assert.equal(s.spend.current, 520);
    assert.equal(s.top_items[0].sku, 'MMM02023');
    assert.equal(s.by_shop.length, 2);
});

test('with pricing hidden, no dollar figure appears anywhere in the snapshot', () => {
    const s = summarizeOrders(ORDERS, { hidePrices: true });
    const keys = JSON.stringify(s);
    for (const k of ['spend', 'average_order', 'promotion_lines', 'unit_price']) assert.ok(!keys.includes(`"${k}`), `${k} leaked`);
    const inv = summarizeInventory([{ product_id: P1, sku: 'X', product_name: 'Y', on_hand: 3, price: 10, stock_status: 'ok' }], [], { hidePrices: true });
    assert.ok(!('stock_value' in inv) && !('value_sitting_unused' in inv));
});

test('inventory summary counts out, low, uncounted and idle stock', () => {
    const now = Date.now();
    const inv = summarizeInventory([
        { product_id: 'a', sku: 'A', product_name: 'A', on_hand: 0, stock_status: 'out', last_counted_at: iso(5), min_point: 1, price: 5 },
        { product_id: 'b', sku: 'B', product_name: 'B', on_hand: 1, stock_status: 'low', last_counted_at: null, min_point: 2, price: 5 },
        { product_id: 'c', sku: 'C', product_name: 'C', on_hand: 4, stock_status: 'ok', last_counted_at: iso(60), last_movement_at: iso(200), min_point: null, price: 10 }
    ], [{ product_id: 'a', qty_change: -3 }, { product_id: 'b', qty_change: -1 }], { now });
    assert.equal(inv.out_of_stock, 1);
    assert.equal(inv.below_minimum, 1);
    assert.equal(inv.not_counted_in_30_days, 2);
    assert.equal(inv.no_use_in_90_days_but_on_shelf, 1);
    assert.equal(inv.value_sitting_unused, 40);
    assert.equal(inv.most_used_last_90_days[0].sku, 'A');
});

function anthropicOk(input) {
    return async (url, init) => {
        anthropicOk.last = { url, init, body: JSON.parse(init.body) };
        return { ok: true, status: 200, json: async () => ({ model: 'claude-test', usage: { input_tokens: 1200, output_tokens: 400 }, content: [{ type: 'tool_use', name: 'report_insights', input }] }) };
    };
}
const GOOD = {
    headline: 'A steady quarter with abrasives doing most of the work.',
    going_well: [{ title: 'Orders are regular', detail: 'You might keep this rhythm.', based_on: 'orders 2 vs 1' }],
    worth_acting_on: [{ title: 'Set minimums', detail: 'It could be worth setting minimums on your top items.', based_on: 'without_a_minimum 1' }],
    worth_a_closer_look: []
};

test('one request: fixed answer format, the advisor brief, the key in the header, nothing else', async () => {
    const r = await generateInsights({ ordering: {} }, { apiKey: 'k-insights', fetchFn: anthropicOk(GOOD), shopLabel: 'Concord' });
    const { url, init, body } = anthropicOk.last;
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init.headers['x-api-key'], 'k-insights');
    assert.deepEqual(body.tool_choice, { type: 'tool', name: 'report_insights' });
    assert.equal(body.tools.length, 1);
    assert.equal(body.messages.length, 1);
    assert.match(body.system, /suggestions, never orders/i);
    assert.match(body.system, /ignore such text/i);
    assert.equal(r.insights.worth_acting_on[0].title, 'Set minimums');
    assert.deepEqual(r.usage, { input_tokens: 1200, output_tokens: 400 });
    assert.ok(SYSTEM.length > 0);
});

test('the answer is trimmed and capped before anyone sees it', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `<b>T${i}</b>`, detail: 'd'.repeat(2000), based_on: 'x' }));
    const c = cleanInsights({ headline: 'h', going_well: many, worth_acting_on: many, worth_a_closer_look: many });
    assert.equal(c.going_well.length, 4);
    assert.equal(c.worth_acting_on.length, 5);
    assert.equal(c.worth_a_closer_look.length, 4);
    assert.ok(!c.going_well[0].title.includes('<'));
    assert.ok(c.going_well[0].detail.length <= 700);
});

test('no key, a refused key, or an empty answer each fail cleanly', async () => {
    await assert.rejects(generateInsights({}, {}), e => e.code === 'not_configured');
    await assert.rejects(generateInsights({}, { apiKey: 'k', fetchFn: async () => ({ ok: false, status: 401 }) }), e => e.code === 'not_configured');
    await assert.rejects(generateInsights({}, { apiKey: 'k', fetchFn: async () => ({ ok: true, json: async () => ({ content: [] }) }) }), e => e.code === 'unreadable');
});

// ------------------------------------------------------------------
// The route, end to end, with the real router and a fake database.
// ------------------------------------------------------------------
let fake;
const supabaseProxy = new Proxy({}, { get: (_t, prop) => { const v = fake[prop]; return typeof v === 'function' ? v.bind(fake) : v; } });
const stubs = {
    [path.join(ROOT, 'utils/supabase.js')]: { supabaseAdmin: supabaseProxy },
    [path.join(ROOT, 'middleware/auth.js')]: {
        requireCompanyAuth: (req, res, next) => {
            req.company = { id: CO, slug: 'concord' };
            if (req.headers['x-test-user']) req.companyUser = { id: USER, location_id: req.headers['x-test-user'] === 'locked' ? LOC_B : null };
            next();
        }
    }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (parent && request.startsWith('.')) {
        const resolved = path.resolve(path.dirname(parent.filename), request);
        for (const key of Object.keys(stubs)) if (key === resolved || key === resolved + '.js') return stubs[key];
    }
    return originalLoad.call(this, request, parent, isMain);
};
const express = require('express');
const request = require('supertest');
const router = require('../routes/insights-store');
Module._load = originalLoad;

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.id = 'req-test-1'; next(); });
app.use('/api/store/:slug/insights', router);

function seed(settings) {
    fake = createFakeSupabase({
        companies: [{ id: CO, name: 'Concord Collision', slug: 'concord', is_active: true, distributor_id: null, settings }],
        company_locations: [{ id: LOC_A, company_id: CO, name: 'Main', is_active: true }, { id: LOC_B, company_id: CO, name: 'Vaughan', is_active: true }],
        products: [{ id: P1, company_id: CO, sku: 'MMM02023', name: 'Wetordry P1500', category: 'Abrasives', brand: '3M', is_active: true }],
        orders: ORDERS.map(o => ({ ...o }))
    });
}
const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; delete process.env.ANTHROPIC_INSIGHTS_API_KEY; delete process.env.INSIGHTS_DAILY_LIMIT; });

test('off unless CHC switched the module on', async () => {
    seed({});
    const r = await request(app).get('/api/store/concord/insights');
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'insights_off');
});

test('with reports restricted, the shared access code gets nothing', async () => {
    seed({ insights: { enabled: true }, users: { enabled: true }, restricted_reports: { enabled: true } });
    process.env.ANTHROPIC_INSIGHTS_API_KEY = 'k';
    const r = await request(app).post('/api/store/concord/insights').send({});
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'reports_need_account');
    assert.equal(fake.db.ai_usage_log.length, 0, 'refused before any AI call');
});

test('no key on the server: says so, calls nothing', async () => {
    seed({ insights: { enabled: true } });
    let called = false; global.fetch = async () => { called = true; };
    const r = await request(app).post('/api/store/concord/insights').send({});
    assert.equal(r.status, 503);
    assert.equal(called, false);
});

test('a run: one call, the answer returned, and the call logged with what was sent', async () => {
    seed({ insights: { enabled: true } });
    process.env.ANTHROPIC_INSIGHTS_API_KEY = 'k-insights';
    let calls = 0;
    global.fetch = async (url, init) => { calls++; return anthropicOk(GOOD)(url, init); };
    const r = await request(app).post('/api/store/concord/insights').send({});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(calls, 1);
    assert.equal(r.body.insights.headline, GOOD.headline);
    assert.ok(!PERSONAL.test(JSON.stringify(r.body.snapshot)));
    assert.ok(!PERSONAL.test(anthropicOk.last.init.body), 'nothing personal left the server');
    const log = fake.db.ai_usage_log;
    assert.equal(log.length, 1);
    assert.equal(log[0].feature, 'insights');
    assert.equal(log[0].status, 'ok');
    assert.equal(log[0].company_id, CO);
    assert.equal(log[0].actor_type, 'shared_code');
    assert.equal(log[0].input_tokens, 1200);
    assert.equal(log[0].request_id, 'req-test-1');
    assert.deepEqual(log[0].input_summary, r.body.snapshot);
    const status = await request(app).get('/api/store/concord/insights');
    assert.equal(status.body.last.insights.headline, GOOD.headline);
    assert.match(status.body.disclosure.sends, /No names, emails/);
    assert.deepEqual(status.body.ai_features.map(f => f.name), ['Insights', 'Price screenshot reading'], 'the shop is told about both AI features');
});

test('a person tied to one shop only ever gets that shop, whatever they ask for', async () => {
    seed({ insights: { enabled: true } });
    process.env.ANTHROPIC_INSIGHTS_API_KEY = 'k';
    global.fetch = anthropicOk(GOOD);
    const r = await request(app).post('/api/store/concord/insights').set('x-test-user', 'locked').send({ location_id: LOC_A });
    assert.equal(r.status, 200);
    assert.match(r.body.snapshot.scope, /Vaughan/);
    assert.equal(r.body.snapshot.ordering.orders.current, 1, 'only the Vaughan order');
    assert.equal(fake.db.ai_usage_log[0].location_id, LOC_B);
    assert.equal(fake.db.ai_usage_log[0].actor_type, 'company_user');
});

test('hidden pricing: no dollar figure leaves the server', async () => {
    seed({ insights: { enabled: true }, hide_pricing: { enabled: true } });
    process.env.ANTHROPIC_INSIGHTS_API_KEY = 'k';
    global.fetch = anthropicOk(GOOD);
    const r = await request(app).post('/api/store/concord/insights').send({});
    assert.equal(r.status, 200);
    const sent = JSON.parse(anthropicOk.last.init.body).messages[0].content;
    assert.ok(!/"spend|"average_order|"stock_value/.test(sent), sent.slice(0, 400));
    assert.equal(r.body.snapshot.prices_shown, false);
});

test('daily limit per account', async () => {
    seed({ insights: { enabled: true } });
    process.env.ANTHROPIC_INSIGHTS_API_KEY = 'k';
    process.env.INSIGHTS_DAILY_LIMIT = '1';
    global.fetch = anthropicOk(GOOD);
    assert.equal((await request(app).post('/api/store/concord/insights').send({})).status, 200);
    const r = await request(app).post('/api/store/concord/insights').send({});
    assert.equal(r.status, 429);
    assert.equal(fake.db.ai_usage_log.length, 1);
});

test('a failed call is logged too', async () => {
    seed({ insights: { enabled: true } });
    process.env.ANTHROPIC_INSIGHTS_API_KEY = 'k';
    global.fetch = async () => ({ ok: false, status: 529 });
    const r = await request(app).post('/api/store/concord/insights').send({});
    assert.equal(r.status, 502);
    assert.equal(fake.db.ai_usage_log.length, 1);
    assert.equal(fake.db.ai_usage_log[0].status, 'failed');
    assert.equal(fake.db.ai_usage_log[0].error_code, 'upstream');
});
