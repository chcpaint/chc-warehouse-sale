/**
 * tests/rate-limit.test.js -- the limit follows the signed-in person, not the IP.
 *   node --test tests/
 */
process.env.JWT_SECRET = 'test-secret';
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const rl = require('../utils/rate-limit');

const req = (token, ip = '203.0.113.7') => ({ ip, headers: token ? { authorization: 'Bearer ' + token } : {} });
const sign = (payload, opts) => jwt.sign(payload, process.env.JWT_SECRET, opts || { expiresIn: '1h' });

test('a signed-in admin gets their own bucket and the higher ceiling, whatever the IP', () => {
    const t = sign({ type: 'admin', admin_id: 'a1' });
    assert.equal(rl.keyGenerator(req(t, '1.1.1.1')), 'admin:a1');
    assert.equal(rl.keyGenerator(req(t, '2.2.2.2')), 'admin:a1');
    assert.equal(rl.maxFor(req(t)), 3000);
});

test('two staff behind one office IP do not share a bucket', () => {
    const a = sign({ type: 'admin', admin_id: 'a1' }), b = sign({ type: 'admin', admin_id: 'a2' });
    assert.notEqual(rl.keyGenerator(req(a)), rl.keyGenerator(req(b)));
});

test('shop users are bucketed per user, shop sessions per company', () => {
    assert.equal(rl.keyGenerator(req(sign({ type: 'company_user', user_id: 'u9', company_id: 'c1' }))), 'company_user:u9');
    assert.equal(rl.keyGenerator(req(sign({ type: 'company', company_id: 'c1' }))), 'company:c1');
});

test('anonymous traffic stays per IP at the strict ceiling', () => {
    assert.equal(rl.keyGenerator(req(null)), 'ip:203.0.113.7');
    assert.equal(rl.maxFor(req(null)), 100);
});

test('a forged, expired or garbage token earns no extra allowance', () => {
    const forged = jwt.sign({ type: 'admin', admin_id: 'a1' }, 'wrong-secret');
    const expired = sign({ type: 'admin', admin_id: 'a1' }, { expiresIn: -10 });
    for (const t of [forged, expired, 'not-a-token']) {
        assert.equal(rl.keyGenerator(req(t)), 'ip:203.0.113.7');
        assert.equal(rl.maxFor(req(t)), 100);
    }
});

test('a valid token with no identity in it is anonymous', () => {
    assert.equal(rl.maxFor(req(sign({ type: 'admin' }))), 100);
});
