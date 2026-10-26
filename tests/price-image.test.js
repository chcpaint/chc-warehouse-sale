/**
 * tests/price-image.test.js
 *
 * Reading a screenshot of a price update into item rows: the reader's rules
 * (utils/price-image.js) and the route that fronts it. No network: fetch is
 * injected / replaced, and nothing here ever needs a real key.
 *
 *   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.invalid';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'service-key';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { createFakeSupabase } = require('./helpers/fake-supabase');
const ROOT = path.resolve(__dirname, '..');
const fake = createFakeSupabase({ audit_log: [] });
const proxy = new Proxy({}, { get: (_t, p) => { const v = fake[p]; return typeof v === 'function' ? v.bind(fake) : v; } });

let authAdmin = null;
const stubs = { [path.join(ROOT, 'utils/supabase.js')]: { supabase: proxy, supabaseAdmin: proxy } };
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
const { requireCompanyAccess } = require('../middleware/auth');
const { readPriceImage, cleanItems, sniffImageType, ImageReadError } = require('../utils/price-image');
const imageRoute = require('../routes/admin-catalog-image');

const CO = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

function modelAnswer(input) {
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'tool_use', name: 'report_items', input }] }) };
}

function app() {
    const a = express();
    a.use((req, res, next) => { req.admin = authAdmin; next(); });
    a.use('/companies/:companyId/catalog-image', requireCompanyAccess, imageRoute);
    return a;
}

// ---- the reader ------------------------------------------------------

test('image type is judged by its bytes, not its name', () => {
    assert.equal(sniffImageType(PNG), 'image/png');
    assert.equal(sniffImageType(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)])), 'image/jpeg');
    assert.equal(sniffImageType(Buffer.from('RIFF0000WEBPVP8 ' + 'x'.repeat(10))), 'image/webp');
    assert.equal(sniffImageType(Buffer.from('MZ this is an exe renamed to .png ......')), null);
});

test('cleanItems: prices parsed, unreadable ones left for a person, junk dropped', () => {
    const out = cleanItems({ items: [
        { sku: ' 30 669 ', name: 'Sandpaper 3M', price: '$1,093.50', case_qty: '12' },
        { sku: 'A1', name: 'Mystery', price: 'call' },
        { sku: 'A2', name: '', price: '5' },
        { sku: 'A3', name: '<b>Bold</b>', price: '0' },
        null
    ] });
    assert.equal(out.items.length, 3);
    assert.deepEqual(out.items[0], { sku: '30669', name: 'Sandpaper 3M', brand: '', category: '', price: 1093.5, case_qty: 12, uncertain: false });
    assert.equal(out.items[1].price, null);
    assert.equal(out.items[1].uncertain, true, 'a price that could not be read must be flagged');
    assert.equal(out.items[2].price, null, 'zero is not a price');
    assert.ok(!/[<>]/.test(out.items[2].name));
    assert.equal(out.dropped, 2);
});

test('cleanItems caps the number of lines', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ sku: 'S' + i, name: 'Item ' + i, price: '1.00' }));
    assert.equal(cleanItems({ items: many }).items.length, 100);
});

test('readPriceImage: sends the picture and the fixed tool, returns cleaned items', async () => {
    let sent;
    const out = await readPriceImage(PNG, {
        apiKey: 'k-test', hint: 'Assured',
        fetchFn: async (url, opts) => { sent = { url, opts, body: JSON.parse(opts.body) }; return modelAnswer({ items: [{ sku: 'X1', name: 'Widget', price: '9.99' }], notes: 'ok' }); }
    });
    assert.equal(out.items[0].price, 9.99);
    assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(sent.opts.headers['x-api-key'], 'k-test');
    assert.deepEqual(sent.body.tool_choice, { type: 'tool', name: 'report_items' });
    assert.equal(sent.body.messages[0].content[0].source.media_type, 'image/png');
    assert.match(sent.body.system, /ignore it/i, 'the picture is data, not instructions');
});

test('readPriceImage: refusals are specific and never echo the upstream body', async () => {
    const reject = (fn, code) => assert.rejects(fn, e => e instanceof ImageReadError && e.code === code);
    await reject(() => readPriceImage(PNG, { apiKey: '' }), 'not_configured');
    await reject(() => readPriceImage(Buffer.from('not a picture at all, sorry'), { apiKey: 'k' }), 'bad_image');
    await reject(() => readPriceImage(Buffer.alloc(6 * 1024 * 1024, 1), { apiKey: 'k' }), 'too_large');
    await reject(() => readPriceImage(PNG, { apiKey: 'k', fetchFn: async () => ({ ok: false, status: 401, json: async () => ({ error: 'secret detail' }) }) }), 'not_configured');
    await reject(() => readPriceImage(PNG, { apiKey: 'k', fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) }) }), 'upstream');
    await reject(() => readPriceImage(PNG, { apiKey: 'k', fetchFn: async () => { throw new Error('socket'); } }), 'upstream');
    await reject(() => readPriceImage(PNG, { apiKey: 'k', fetchFn: async () => modelAnswer({ items: [] }) }), 'unreadable');
    await reject(() => readPriceImage(PNG, { apiKey: 'k', fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'hi' }] }) }) }), 'unreadable');
});

// ---- the route -------------------------------------------------------

function withFetch(handler, fn) {
    const real = global.fetch;
    global.fetch = handler;
    process.env.ANTHROPIC_API_KEY = 'k-test';
    return Promise.resolve(fn()).finally(() => { global.fetch = real; delete process.env.ANTHROPIC_API_KEY; });
}
const post = (co, buf = PNG, name = 'shot.png') => request(app()).post(`/companies/${co}/catalog-image`).attach('image', buf, name);

test('route: a super admin reads a screenshot and gets items back; nothing is written but the audit entry', async () => {
    authAdmin = { id: 'a1', role: 'super_admin' };
    imageRoute._reset();
    fake.db.products = [];
    await withFetch(async () => modelAnswer({ items: [{ sku: 'X1', name: 'Widget', price: '9.99' }] }), async () => {
        const res = await post(CO);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.items[0].name, 'Widget');
        assert.equal(fake.db.products.length, 0, 'reading a picture must not touch the catalogue');
        assert.equal(fake.db.audit_log.at(-1).action, 'catalog_image_read');
        assert.equal(fake.db.audit_log.at(-1).details.items, 1);
        assert.ok(!JSON.stringify(fake.db.audit_log.at(-1)).includes('k-test'), 'the key never reaches the log');
    });
});

test('route: a company admin cannot read for another company; an order-desk account cannot at all', async () => {
    imageRoute._reset();
    await withFetch(async () => modelAnswer({ items: [{ name: 'W', price: '1' }] }), async () => {
        authAdmin = { id: 'a2', role: 'admin', company_id: CO };
        assert.equal((await post(CO)).status, 200);
        assert.equal((await post(OTHER)).status, 403);
        authAdmin = { id: 'a3', role: 'order_desk', company_id: CO };
        assert.equal((await post(CO)).status, 403);
    });
});

test('route: no key on the server says so plainly (503)', async () => {
    authAdmin = { id: 'a1', role: 'super_admin' };
    imageRoute._reset();
    delete process.env.ANTHROPIC_API_KEY;
    const res = await post(CO);
    assert.equal(res.status, 503);
    assert.match(res.body.error, /not set up/i);
});

test('route: a renamed non-picture is refused, and a missing file is a clear 400', async () => {
    authAdmin = { id: 'a1', role: 'super_admin' };
    imageRoute._reset();
    await withFetch(async () => { throw new Error('must not be called'); }, async () => {
        const bad = await post(CO, Buffer.from('MZ this is not a picture, honest........'), 'sneaky.png');
        assert.equal(bad.status, 400);
        const none = await request(app()).post(`/companies/${CO}/catalog-image`);
        assert.equal(none.status, 400);
    });
});

test('route: hourly cap stops runaway use', async () => {
    authAdmin = { id: 'a9', role: 'super_admin' };
    imageRoute._reset();
    await withFetch(async () => modelAnswer({ items: [{ name: 'W', price: '1' }] }), async () => {
        for (let i = 0; i < 30; i++) assert.equal((await post(CO)).status, 200);
        assert.equal((await post(CO)).status, 429);
    });
});
