/**
 * utils/audit.js
 *
 * A route writing to audit_log almost always passes it the same object it
 * just wrote to the database -- convenient, but that object can carry a
 * bcrypt hash (an access code, a password) that has no reason to also live in
 * a JSONB column read by anyone with audit-log access. redactSecrets() is the
 * one place that strips those before the write, so "log what changed" and
 * "log the actual secret" can never accidentally become the same call.
 */

/**
 * Returns a shallow copy of `fields` with each key in `keys` that is present
 * replaced by `placeholder`. Keys not present in `fields` are left absent --
 * this only redacts, it never adds a field that wasn't part of the change.
 */
function redactSecrets(fields, keys, placeholder = '(redacted)') {
    const out = { ...(fields || {}) };
    for (const key of keys || []) {
        if (key in out) out[key] = placeholder;
    }
    return out;
}

module.exports = { redactSecrets };
