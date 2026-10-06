/**
 * tests/shopsafe-launch.test.js
 *
 * The portal -> ShopSafe hand-off token. ShopSafe trusts exactly these claims,
 * so their shape, lifetime, audience and secret are pinned here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const SECRET = 'test-shopsafe-handoff-secret-0123456789abcdef';
process.env.SHOPSAFE_URL = 'https://shopsafe.example/';
process.env.SHOPSAFE_HANDOFF_SECRET = SECRET;
const { buildLaunchUrl, shopsafeConfigured } = require('../utils/shopsafe');
const { moduleEnabled } = require('../utils/modules');

const company = { id: '11111111-1111-4111-8111-111111111111', name: 'Concord Collision' };
const location = { id: '22222222-2222-4222-8222-222222222222', name: 'Bolton', province: 'ON' };

function tokenFrom(url) {
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, 'https://shopsafe.example/launch');
    return u.searchParams.get('t');
}

test('builds a short-lived, single-use, audience-bound hand-off token', () => {
    const url = buildLaunchUrl({ company, location, user: { id: '33333333-3333-4333-8333-333333333333', email: 'gm@concord.example', name: 'GM', role: 'owner' }, distributorId: 'd' });
    const claims = jwt.verify(tokenFrom(url), SECRET, { algorithms: ['HS256'], issuer: 'refinishai-portal', audience: 'refinishai-shopsafe' });
    assert.equal(claims.typ, 'shopsafe_handoff');
    assert.ok(claims.jti && claims.jti.length >= 32);
    assert.ok(claims.exp - claims.iat <= 120, 'lives two minutes at most');
    assert.equal(claims.company_id, company.id);
    assert.equal(claims.location_id, location.id);
    assert.equal(claims.province, 'ON');
    assert.equal(claims.user.role, 'owner');
});

test('the shared access-code session is marked shared and capped at manager', () => {
    const url = buildLaunchUrl({ company, location, user: { id: null, shared: true, email: 'office@concord.example', name: 'Concord team', role: 'owner' } });
    const claims = jwt.decode(tokenFrom(url));
    assert.equal(claims.user.shared, true);
    assert.equal(claims.user.role, 'manager');
    assert.equal(claims.user.id, null);
});

test('anything other than an owner arrives as a manager', () => {
    const url = buildLaunchUrl({ company, location: null, user: { id: '44444444-4444-4444-8444-444444444444', email: 'a@b.example', name: 'A', role: 'member' } });
    const claims = jwt.decode(tokenFrom(url));
    assert.equal(claims.user.role, 'manager');
    assert.equal(claims.location_id, null);
});

test('two clicks never produce the same token id', () => {
    const a = jwt.decode(tokenFrom(buildLaunchUrl({ company, location, user: { email: 'a@b.example', name: 'A', role: 'member' } })));
    const b = jwt.decode(tokenFrom(buildLaunchUrl({ company, location, user: { email: 'a@b.example', name: 'A', role: 'member' } })));
    assert.notEqual(a.jti, b.jti);
});

test('is not signed with the portal session secret', () => {
    process.env.JWT_SECRET = 'portal-session-secret-xxxxxxxxxxxxxxxxxxxx';
    const t = tokenFrom(buildLaunchUrl({ company, location, user: { email: 'a@b.example', name: 'A', role: 'member' } }));
    assert.throws(() => jwt.verify(t, process.env.JWT_SECRET));
});

test('refuses to build without configuration', () => {
    const saved = process.env.SHOPSAFE_HANDOFF_SECRET;
    process.env.SHOPSAFE_HANDOFF_SECRET = 'short';
    assert.equal(shopsafeConfigured(), false);
    assert.throws(() => buildLaunchUrl({ company, location, user: { email: 'a@b.example', name: 'A', role: 'member' } }));
    process.env.SHOPSAFE_HANDOFF_SECRET = saved;
});

test('the shopsafe module is off unless switched on', () => {
    assert.equal(moduleEnabled({}, 'shopsafe'), false);
    assert.equal(moduleEnabled({ shopsafe: { enabled: true } }, 'shopsafe'), true);
});
