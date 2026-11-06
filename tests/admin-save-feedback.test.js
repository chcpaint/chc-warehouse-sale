/**
 * tests/admin-save-feedback.test.js
 *
 * Saving a company setting in the admin console must say so on screen, and every
 * long company panel must have a Done button that is always in view. The console
 * is one inline script, so these check the source it ships with.
 *
 *   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'admin/index.html'), 'utf8');
const fn = (name) => {
    const i = html.indexOf(`function ${name}(`);
    assert.ok(i >= 0, `${name} not found`);
    const next = html.indexOf('\n    async function ', i + 20);
    return html.slice(i, next > 0 ? next : i + 3000);
};

test('the inline admin script parses', () => {
    const m = html.match(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/);
    assert.doesNotThrow(() => new Function(m[1]));
});

test('a toast helper and Done bars exist, and the Done bar is pinned to the bottom of the panel', () => {
    assert.match(html, /function adminToast\(/);
    assert.match(html, /function addDoneBars\(/);
    // Pinned to the bottom edge of the panel (-bottom-6 cancels the panel's p-6 so it sits flush).
    assert.match(html, /sticky -bottom-6/);
});

test('every company panel gets a Done bar', () => {
    for (const id of ['modules-modal', 'fees-modal', 'kits-modal', 'locations-modal',
        'email-recipients-modal', 'company-users-modal', 'branches-modal']) {
        assert.ok(html.includes(`'${id}'`), id);
        assert.ok(html.includes(`id="${id}"`), `${id} markup`);
    }
});

test('the module switch, purchase-order save and tax save each confirm on screen', () => {
    assert.match(fn('setModule'), /adminToast\(/);
    assert.match(fn('savePoSettings'), /adminToast\(/);
    assert.match(fn('saveTaxSettings'), /adminToast\(/);
});

test('failures still raise an alert and do not claim success', () => {
    const body = fn('setModule');
    assert.ok(body.indexOf("alert(data.error || 'Failed to change that module.')") < body.indexOf('adminToast('));
});
