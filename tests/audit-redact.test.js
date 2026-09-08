/**
 * tests/audit-redact.test.js
 *
 * utils/audit.js exists for one reason: routes/admin.js's company-update
 * route writes a bcrypt hash of a customer's access code straight to
 * companies.access_code, then used to pass that same object to the audit
 * log -- so the hash ended up sitting in audit_log.details too, readable by
 * anyone with audit-log access. redactSecrets() is what stands between "log
 * what changed" and "log the actual secret".
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSecrets } = require('../utils/audit');

test('a listed key present in the object is replaced with the placeholder', () => {
    const out = redactSecrets({ name: 'Concord Collision Center', access_code: '$2b$12$abc...' },
        ['access_code'], '(reset)');
    assert.equal(out.access_code, '(reset)');
    assert.equal(out.name, 'Concord Collision Center'); // untouched
});

test('a listed key that is absent stays absent -- redacting never invents a field', () => {
    const out = redactSecrets({ name: 'Concord Collision Center' }, ['access_code'], '(reset)');
    assert.equal('access_code' in out, false);
});

test('only the listed keys are touched -- everything else in the update is still visible in the audit trail', () => {
    const out = redactSecrets(
        { name: 'New Name', contact_email: 'ops@example.invalid', access_code: 'hash-goes-here' },
        ['access_code']);
    assert.equal(out.name, 'New Name');
    assert.equal(out.contact_email, 'ops@example.invalid');
    assert.notEqual(out.access_code, 'hash-goes-here');
});

test('defaults to a generic placeholder when none is given', () => {
    const out = redactSecrets({ password_hash: 'x' }, ['password_hash']);
    assert.equal(out.password_hash, '(redacted)');
});

test('the original object passed in is never mutated', () => {
    const original = { access_code: 'hash-goes-here' };
    redactSecrets(original, ['access_code'], '(reset)');
    assert.equal(original.access_code, 'hash-goes-here');
});

test('an empty or missing key list is a safe no-op copy', () => {
    const original = { name: 'X', access_code: 'hash' };
    assert.deepEqual(redactSecrets(original, []), original);
    assert.deepEqual(redactSecrets(original), original);
});

test('a falsy fields argument does not throw -- returns an empty object', () => {
    assert.deepEqual(redactSecrets(null, ['access_code']), {});
    assert.deepEqual(redactSecrets(undefined, ['access_code']), {});
});

// ==================================================================
// The actual regression this exists for: routes/admin.js's PUT
// /companies/:companyId writes `filtered` (which carries the bcrypt hash
// under `access_code` when the caller is resetting one) straight to
// companies, then must NOT pass that same object to the audit log unaltered.
// ==================================================================

test('mirrors the exact call routes/admin.js makes when an access code is reset', () => {
    // filtered, as PUT /companies/:companyId builds it after bcrypt.hash()
    const filtered = { access_code: '$2b$12$ocNar6oaMdMq/8g/MxH28Ond32/PDYslXy74n.VLuK6/a0sL1GYr2' };
    const auditDetails = redactSecrets(filtered, ['access_code'], '(reset)');
    assert.equal(auditDetails.access_code, '(reset)');
    assert.ok(!String(auditDetails.access_code).startsWith('$2b$'), 'no bcrypt hash should ever reach the audit log');
});
