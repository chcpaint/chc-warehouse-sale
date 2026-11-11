/**
 * tests/hardening.test.js -- request ids, readiness probe, start-up warnings.
 */
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { requestId } = require('../utils/request-id');
const { checkDatabase } = require('../utils/health');
const { configWarnings } = require('../utils/config-check');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function appWithId() {
    const app = express();
    app.use(requestId);
    app.get('/x', (req, res) => res.json({ id: req.id }));
    return app;
}

test('every request gets an id, returned in X-Request-Id', async () => {
    const res = await request(appWithId()).get('/x');
    assert.match(res.headers['x-request-id'], UUID);
    assert.equal(res.body.id, res.headers['x-request-id']);
});

test('a plain caller-supplied id is kept', async () => {
    const res = await request(appWithId()).get('/x').set('X-Request-Id', 'lb-req-12345678');
    assert.equal(res.headers['x-request-id'], 'lb-req-12345678');
});

test('an unsafe or oversize id is replaced, never echoed', async () => {
    for (const bad of ['short', 'has spaces in it 12345', '<script>alert(1)</script>', 'a'.repeat(200)]) {
        const res = await request(appWithId()).get('/x').set('X-Request-Id', bad);
        assert.match(res.headers['x-request-id'], UUID, `replaced: ${bad.slice(0, 20)}`);
    }
});

function fakeDb(result) {
    return { from: () => ({ select: () => ({ limit: () => result }) }) };
}

test('readiness: ok when the database answers', async () => {
    const r = await checkDatabase(fakeDb(Promise.resolve({ data: [{ id: 1 }], error: null })));
    assert.equal(r.ok, true);
    assert.ok(r.ms >= 0);
});

test('readiness: a query error is reported without leaking the message', async () => {
    const r = await checkDatabase(fakeDb(Promise.resolve({ data: null, error: { message: 'secret detail' } })));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'query_failed');
    assert.ok(!JSON.stringify(r).includes('secret'));
});

test('readiness: a thrown error and a hang both fail cleanly', async () => {
    const thrown = await checkDatabase({ from: () => { throw new Error('boom'); } });
    assert.deepEqual([thrown.ok, thrown.error], [false, 'unreachable']);
    const hung = await checkDatabase(fakeDb(new Promise(() => {})), 30);
    assert.deepEqual([hung.ok, hung.error], [false, 'timeout']);
    assert.ok(hung.ms < 1000);
});

const GOOD = {
    JWT_SECRET: 'x'.repeat(48), SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k',
    NODE_ENV: 'production', APP_URL: 'https://chcsale.com', SENDGRID_API_KEY: 's'
};

test('config check: a healthy production environment has no warnings', () => {
    assert.deepEqual(configWarnings(GOOD), []);
});

test('config check: flags a missing or short signing secret, never prints it', () => {
    assert.match(configWarnings({ ...GOOD, JWT_SECRET: '' })[0], /not set/);
    const short = configWarnings({ ...GOOD, JWT_SECRET: 'abc123' });
    assert.match(short[0], /shorter than 32/);
    assert.ok(!short.join(' ').includes('abc123'));
});

test('config check: SMTP_PASS counts as an email key; APP_URL matters only in production', () => {
    const noMail = { ...GOOD }; delete noMail.SENDGRID_API_KEY;
    assert.equal(configWarnings(noMail).length, 1);
    assert.deepEqual(configWarnings({ ...noMail, SMTP_PASS: 'key' }), []);
    const dev = { ...GOOD, NODE_ENV: 'development' }; delete dev.APP_URL; delete dev.SENDGRID_API_KEY;
    assert.deepEqual(configWarnings(dev), []);
});
