/**
 * tests/po-admin.test.js
 *
 * The admin PO settings route, including the "no PO needed under $X" rule that CHC
 * can set for any company: turn the PO requirement on (the shop supplies it), then
 * set a dollar threshold, then save it.
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
const supabaseProxy = new Proxy({}, {
    get: (_t, prop) => { const v = fake[prop]; return typeof v === 'function' ? v.bind(fake) : v; }
});

const stubs = {
    [path.join(ROOT, 'utils/supabase.js')]: { supabaseAdmin: supabaseProxy },
    [path.join(ROOT, 'middleware/auth.js')]: {
        requireCompanyAccess: (req, res, next) => { req.admin = { id: 'adm-1', role: 'super_admin' }; next(); }
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
const poAdmin = require('../routes/po-admin');

const CO = '11111111-1111-4111-8111-111111111111';

function reset(settings) {
    fake = createFakeSupabase({
        companies: [{ id: CO, name: 'New Shop', slug: 'new-shop', is_active: true, settings: settings || {} }],
        company_po_sequences: [], orders: [], audit_log: []
    });
}
function app() { const a = express(); a.use(express.json()); a.use('/api/admin/companies/:companyId/po', poAdmin); return a; }
const url = `/api/admin/companies/${CO}/po`;
const put = (body) => request(app()).put(url).send(body);
const stored = () => fake.db.companies[0].settings.purchase_orders;

test('GET reports the saved threshold, and null when there is none', async () => {
    reset({ purchase_orders: { mode: 'manual', optional_below: 500 } });
    assert.equal((await request(app()).get(url)).body.optional_below, 500);
    reset({});
    const r = await request(app()).get(url);
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'manual');
    assert.equal(r.body.optional_below, null);
});

test('turn on the PO requirement, set a dollar threshold, save: it is stored on that company', async () => {
    reset({});
    const res = await put({ mode: 'manual', optional_below: 500 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(stored(), { mode: 'manual', optional_below: 500 });
    assert.match(res.body.message, /Orders under \$500\.00 before tax need no PO/);
    assert.equal(res.body.optional_below, 500);
});

test('saving the rule changes nothing else on the company (sign-in, kits, tax...)', async () => {
    const other = { users: { enabled: true }, kits: { a: 1 }, tax: { rate: 0.13 }, inventory: { enabled: true } };
    reset({ ...other });
    await put({ mode: 'manual', optional_below: 250.5 });
    const s = fake.db.companies[0].settings;
    for (const k of Object.keys(other)) assert.deepEqual(s[k], other[k], k);
    assert.equal(s.purchase_orders.optional_below, 250.5);
});

test('the amount is rounded to the cent', async () => {
    reset({});
    await put({ mode: 'manual', optional_below: '499.999' });
    assert.equal(stored().optional_below, 500);
});

test('null or an empty amount removes the rule: every order needs a PO again', async () => {
    reset({ purchase_orders: { mode: 'manual', optional_below: 500 } });
    const res = await put({ mode: 'manual', optional_below: null });
    assert.equal(res.status, 200);
    assert.equal('optional_below' in stored(), false);
    assert.equal(res.body.optional_below, null);
    reset({ purchase_orders: { mode: 'manual', optional_below: 500 } });
    await put({ mode: 'manual', optional_below: '' });
    assert.equal('optional_below' in stored(), false);
});

test('a save that does not mention the amount keeps the saved rule (the radio buttons auto-save)', async () => {
    reset({ purchase_orders: { mode: 'manual', optional_below: 500 } });
    const res = await put({ mode: 'manual' });
    assert.equal(res.status, 200);
    assert.equal(stored().optional_below, 500);
});

test('bad amounts are refused and nothing is saved', async () => {
    for (const bad of [0, -1, 'abc', true, 100001, 500000]) {
        reset({ purchase_orders: { mode: 'manual', optional_below: 500 } });
        const res = await put({ mode: 'manual', optional_below: bad });
        assert.equal(res.status, 400, `optional_below=${bad}`);
        assert.equal(stored().optional_below, 500, 'the saved rule must be untouched');
    }
});

test('the threshold is ignored unless the shop supplies its own PO', async () => {
    reset({});
    await put({ mode: 'off', optional_below: 500 });
    assert.equal('optional_below' in stored(), false);
});

test('switching away from manual keeps the rule on file but it does nothing there', async () => {
    reset({ purchase_orders: { mode: 'manual', optional_below: 500 } });
    await put({ mode: 'off' });
    assert.equal(stored().mode, 'off');
    assert.equal(stored().optional_below, 500, 'kept so switching back restores it');
    const g = await request(app()).get(url);
    assert.equal(g.body.optional_below, null, 'inert while the company is not on typed POs');
});

test('the change is written to the audit log with the amount', async () => {
    reset({});
    await put({ mode: 'manual', optional_below: 500 });
    const row = fake.db.audit_log[0];
    assert.equal(row.action, 'po_settings_updated');
    assert.equal(row.details.optional_below, 500);
});

test('an unknown company is a 404', async () => {
    reset({});
    const res = await request(app()).put(`/api/admin/companies/22222222-2222-4222-8222-222222222222/po`).send({ mode: 'manual', optional_below: 5 });
    assert.equal(res.status, 404);
});

test('end to end: a rule saved here is the rule the order route enforces', () => {
    const { resolveOrderPo } = require('../utils/po');
    reset({});
    return put({ mode: 'manual', optional_below: 500 }).then(() => {
        const settings = fake.db.companies[0].settings;
        assert.equal(resolveOrderPo(settings, '', { subtotal: 499.99 }).ok, true);
        assert.equal(resolveOrderPo(settings, '', { subtotal: 500 }).ok, false);
    });
});

test('the console has the controls: tick box, amount, Save rule, and it posts the amount', () => {
    const html = require('node:fs').readFileSync(path.join(ROOT, 'admin/index.html'), 'utf8');
    for (const id of ['po-threshold-setup', 'po-threshold-on', 'po-threshold-amount', 'po-threshold-hint']) {
        assert.ok(html.includes(`id="${id}"`), id);
    }
    assert.match(html, /onclick="savePoThreshold\(\)"/);
    assert.match(html, /savePoSettings\('manual', \{ optional_below \}\)/);
    assert.match(html, /classList\.toggle\('hidden', mode !== 'manual'\)/);
});
